// Выставление счёта из сделки Битрикса: счёт на оплату в 1С («Мой арбитр») + смарт-счёт в Битриксе у сделки.
import { companies } from './config.js';
import { odataGetAll, odataPost } from './odata.js';
import { bx } from './bitrixApi.js';
import { nameKey } from './branches.js';
import { sameName } from './report.js';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const SERVICE_TEXT = 'Юридические услуги';
const BX_INVOICE = 31, BX_CATEGORY = 3, BX_STAGE_NEW = 'DT31_3:N';
const TERM_DAYS = 5;
const conn = () => companies.find(c => c.id === 'moy') || companies[0];

const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localIso = d => `${fmtDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
const fullName = c => [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ').trim();

// Сделка и клиент из Битрикса
export async function loadDeal(dealId) {
  const deal = (await bx('crm.deal.get', { id: dealId })).result;
  if (!deal) throw new Error('Сделка не найдена');
  let clientName = '';
  if (Number(deal.CONTACT_ID)) clientName = fullName((await bx('crm.contact.get', { id: deal.CONTACT_ID })).result || {});
  else if (Number(deal.COMPANY_ID)) clientName = (await bx('crm.company.get', { id: deal.COMPANY_ID })).result?.TITLE || '';
  const existing = (await bx('crm.item.list', { entityTypeId: BX_INVOICE, filter: { parentId2: dealId }, select: ['id', 'title', 'accountNumber', 'opportunity', 'stageId', 'createdTime'] })).result?.items || [];
  return { deal, clientName, existing };
}

// Клиент в 1С: ищем по ФИО без учёта порядка слов и регистра
async function findClient(name) {
  const key = nameKey(name);
  const list = await odataGetAll(conn(), 'Catalog_Контрагенты', { $select: 'Ref_Key,Code,Description,DeletionMark,IsFolder,ОсновнойДоговорКонтрагента_Key,Parent_Key,КБЕ,СтранаРезидентства_Key,ЮрФизЛицо' });
  const found = list.filter(c => !c.IsFolder && nameKey(c.Description) === key);
  return { match: found.find(c => !c.DeletionMark) || null, template: list.filter(c => !c.IsFolder && !c.DeletionMark && c.ЮрФизЛицо === 'ФизЛицо').pop() };
}

// Параметры счёта «как обычно» берём из последнего неудалённого счёта
async function templateInvoice() {
  const inv = await odataGetAll(conn(), 'Document_СчетНаОплатуПокупателю', { $filter: 'DeletionMark eq false', $orderby: 'Date desc', $top: 1 });
  if (!inv[0]) throw new Error('В 1С нет счетов-образцов, нечего копировать');
  return inv[0];
}

// Предпросмотр: что будет создано, ничего не пишем
export async function preview(dealId) {
  const { deal, clientName, existing } = await loadDeal(dealId);
  if (!clientName) throw new Error('У сделки нет контакта или компании');
  const { match } = await findClient(clientName);
  return {
    dealId, title: deal.TITLE, client: clientName, clientInOneC: !!match, amount: Number(deal.OPPORTUNITY) || 0,
    service: SERVICE_TEXT, assignedById: deal.ASSIGNED_BY_ID, existing,
  };
}

const locks = new Set();

export async function createInvoice(dealId, { amount, service }) {
  amount = Number(amount);
  if (!(amount > 0)) throw new Error('Сумма счёта должна быть больше нуля');
  if (locks.has(dealId)) throw new Error('Счёт по этой сделке уже создаётся, подождите');
  locks.add(dealId);
  try {
    const { deal, clientName, existing } = await loadDeal(dealId);
    if (!clientName) throw new Error('У сделки нет контакта или компании');
    const c = conn();
    const marker = `Сделка Битрикс24 #${dealId}`;
    // Если прошлая попытка создала счёт в 1С, а Битрикс отказал, повторно в 1С не создаём
    const prev = (await odataGetAll(c, 'Document_СчетНаОплатуПокупателю', { $filter: `Комментарий eq '${marker}' and DeletionMark eq false` }))
      .filter(d => Number(d.СуммаДокумента) === amount)
      .find(d => !existing.some(e => String(e.accountNumber || '').replace(/^1С-/, '') === String(d.Number).replace(/^0+/, '')));
    const tpl = await templateInvoice();
    let { match, template } = prev ? { match: null, template: null } : await findClient(clientName);

    // 1. Клиент
    let client = match;
    let createdClient = false;
    if (!client && !prev) {
      if (!template) throw new Error('Нет образца контрагента в 1С');
      client = await odataPost(c, 'Catalog_Контрагенты', {
        Parent_Key: template.Parent_Key, Description: clientName, НаименованиеПолное: clientName,
        ЮрФизЛицо: 'ФизЛицо', КБЕ: template.КБЕ, СтранаРезидентства_Key: template.СтранаРезидентства_Key,
      });
      createdClient = true;
    }

    // 2. Договор
    let contractKey = prev ? prev.ДоговорКонтрагента_Key : client.ОсновнойДоговорКонтрагента_Key;
    if (!prev && (!contractKey || contractKey === EMPTY)) {
      const contracts = await odataGetAll(c, 'Catalog_ДоговорыКонтрагентов', { $filter: `Owner_Key eq guid'${client.Ref_Key}' and DeletionMark eq false`, $top: 1 });
      contractKey = contracts[0]?.Ref_Key;
    }
    if (!prev && !contractKey) {
      const ct = (await odataGetAll(c, 'Catalog_ДоговорыКонтрагентов', { $filter: 'DeletionMark eq false', $orderby: 'Code desc', $top: 1 }))[0];
      if (!ct) throw new Error('Нет образца договора в 1С');
      const made = await odataPost(c, 'Catalog_ДоговорыКонтрагентов', {
        Owner_Key: client.Ref_Key, Description: `Счёт от ${fmtDate(new Date())}`, Организация_Key: ct.Организация_Key,
        ВалютаВзаиморасчетов_Key: ct.ВалютаВзаиморасчетов_Key, ВедениеВзаиморасчетов: ct.ВедениеВзаиморасчетов,
        ВидДоговора: ct.ВидДоговора, УсловияОплаты: ct.УсловияОплаты, ТипЦен_Key: ct.ТипЦен_Key,
      });
      contractKey = made.Ref_Key;
    }

    // 3. Ответственный: 1С-пользователь с тем же именем, что и ответственный по сделке
    let respKey = tpl.Ответственный_Key;
    try {
      const bxUser = (await bx('user.get', { ID: deal.ASSIGNED_BY_ID })).result?.[0];
      const users = await odataGetAll(c, 'Catalog_Пользователи', { $select: 'Ref_Key,Description' });
      const who = users.find(u => bxUser && sameName(u.Description, [bxUser.LAST_NAME, bxUser.NAME].join(' ')));
      if (who) respKey = who.Ref_Key;
    } catch { /* оставляем ответственного из образца */ }

    // 4. Счёт на оплату в 1С (как и существующие: непроведённый, одна строка услуги)
    const now = new Date();
    const text = String(service || '').trim() || SERVICE_TEXT;
    const row = (tpl.Услуги || [])[0] || {};
    const doc = prev || await odataPost(c, 'Document_СчетНаОплатуПокупателю', {
      Date: localIso(now), Posted: false,
      Организация_Key: tpl.Организация_Key, Контрагент_Key: client?.Ref_Key, ДоговорКонтрагента_Key: contractKey,
      ВалютаДокумента_Key: tpl.ВалютаДокумента_Key, КратностьВзаиморасчетов: tpl.КратностьВзаиморасчетов, КурсВзаиморасчетов: tpl.КурсВзаиморасчетов,
      Склад_Key: tpl.Склад_Key, СтруктурнаяЕдиница: tpl.СтруктурнаяЕдиница, СтруктурнаяЕдиница_Type: tpl.СтруктурнаяЕдиница_Type,
      Автор_Key: tpl.Автор_Key, Ответственный_Key: respKey,
      СуммаВключаетНДС: false, УчитыватьНДС: false, СуммаВключаетАкциз: false, УчитыватьАкциз: false,
      СуммаДокумента: amount, Комментарий: marker,
      Услуги: [{ LineNumber: '1', Содержание: text, Количество: 1, Цена: amount, Сумма: amount, СтавкаНДС_Key: row.СтавкаНДС_Key || EMPTY, СуммаНДС: 0, Номенклатура_Key: row.Номенклатура_Key }],
    });
    const number = String(doc.Number || '').trim();
    const shortNo = number.replace(/^0+/, '') || number;

    // 5. Смарт-счёт в Битриксе, привязанный к сделке
    const sample = (await bx('crm.item.list', { entityTypeId: BX_INVOICE, filter: { categoryId: BX_CATEGORY }, order: { id: 'DESC' }, select: ['id', 'mycompanyId'] })).result?.items?.[0];
    const close = new Date(now.getTime() + TERM_DAYS * 86400000);
    let item;
    try { item = (await bx('crm.item.add', {
      entityTypeId: BX_INVOICE,
      fields: {
        title: `Счет № ${shortNo} по клиенту ${clientName}`, categoryId: BX_CATEGORY, stageId: BX_STAGE_NEW,
        parentId2: dealId, contactId: Number(deal.CONTACT_ID) || undefined, companyId: Number(deal.COMPANY_ID) || undefined,
        opportunity: amount, currencyId: 'KZT', assignedById: deal.ASSIGNED_BY_ID, mycompanyId: sample?.mycompanyId,
        accountNumber: `1С-${shortNo}`, begindate: fmtDate(now), closedate: fmtDate(close),
      },
    })).result?.item; } catch (e) { throw new Error(`Счёт № ${shortNo} создан в 1С, но Битрикс его не принял: ${e.message}. Нажмите кнопку ещё раз, дубль в 1С не создастся.`); }
    try { await bx('crm.timeline.comment.add', { fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: `Выставлен счёт № ${shortNo} на ${amount} ₸ (1С «Мой арбитр»)` } }); } catch { /* комментарий не критичен */ }

    return {
      number: shortNo, oneCNumber: number, date: fmtDate(now), dueDate: fmtDate(close), client: clientName, createdClient,
      amount, service: text, oneCRef: doc.Ref_Key, bitrixInvoiceId: item?.id || null, dealId,
    };
  } finally { locks.delete(dealId); }
}
