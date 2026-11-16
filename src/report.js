// Сборка сводки: счета, начисления, оплаты, дебиторка, просрочка
import { config, companies } from './config.js';
import * as real from './source1c.js';
import * as mock from './sourceMock.js';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const DAY = 86400000;

export const BUCKETS = [
  { id: 'current', label: 'В сроке', min: -Infinity, max: 0 },
  { id: 'd1_30', label: '1–30 дн.', min: 1, max: 30 },
  { id: 'd31_60', label: '31–60 дн.', min: 31, max: 60 },
  { id: 'd61_90', label: '61–90 дн.', min: 61, max: 90 },
  { id: 'd90', label: 'Более 90 дн.', min: 91, max: Infinity },
];
const bucketOf = days => BUCKETS.find(b => days >= b.min && days <= b.max).id;
const emptyAging = () => Object.fromEntries(BUCKETS.map(b => [b.id, 0]));
const round = n => Math.round(n * 100) / 100;

// Возвращает ссылку на контрагента из проводки (ищет субконто с типом Контрагенты)
function clientRef(rec, side) {
  for (let i = 1; i <= 3; i++) {
    const type = rec[`ExtDimension${side}${i}_Type`] || '';
    if (type.includes('Контрагент')) return rec[`ExtDimension${side}${i}`];
  }
  return rec[`ExtDimension${side}1`] || EMPTY;
}
function balanceClientRef(row) {
  for (let i = 1; i <= 3; i++) {
    const type = row[`ExtDimension${i}_Type`] || '';
    if (type.includes('Контрагент')) return row[`ExtDimension${i}`];
  }
  return row.ExtDimension1 || EMPTY;
}
const res = (row, suffix) => {
  const v = row[`${config.regResource}${suffix}`];
  return typeof v === 'number' ? v : Number(v) || 0;
};

// Счёт + все его субсчета по иерархии
function resolveAccountKeys(accounts, codes) {
  const byParent = new Map();
  for (const a of accounts) {
    if (!byParent.has(a.Parent_Key)) byParent.set(a.Parent_Key, []);
    byParent.get(a.Parent_Key).push(a);
  }
  const keys = new Set();
  const walk = a => {
    keys.add(a.Ref_Key);
    for (const ch of byParent.get(a.Ref_Key) || []) walk(ch);
  };
  const missing = [];
  for (const code of codes) {
    const found = accounts.filter(a => String(a.Code).trim() === code);
    if (!found.length) missing.push(code);
    found.forEach(walk);
  }
  return { keys: [...keys], missing };
}

async function buildCompanyReport(conn, { from, to }) {
  const src = config.mock ? mock : real;
  const warnings = [];
  const asOf = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1, 0, 0, 0); // конец дня "to"
  const toEnd = new Date(asOf.getTime() - 1000);
  const lookFrom = new Date(to.getFullYear(), to.getMonth() - config.agingLookbackMonths, 1);
  const recFrom = lookFrom < from ? lookFrom : from;

  // 1. План счетов
  const accounts = await src.getAccounts(conn);
  const recv = resolveAccountKeys(accounts, config.accReceivable);
  const adv = resolveAccountKeys(accounts, config.accAdvances);
  if (recv.missing.length) throw new Error(`[${conn.name}] В плане счетов не найден счёт ${recv.missing.join(', ')}. Проверь ACC_RECEIVABLE`);
  if (adv.missing.length) warnings.push(`[${conn.name}] Не найден счёт авансов ${adv.missing.join(', ')}, авансы не учитываются`);
  const recvSet = new Set(recv.keys);
  const advSet = new Set(adv.keys);
  const settleSet = new Set([...recv.keys, ...adv.keys]);

  // 2. Параллельно: остатки, проводки, счета на оплату, справочники
  const [bal, records, invoicesRaw, clientsRaw, usersRaw] = await Promise.all([
    src.getBalance(conn, asOf, [...settleSet]),
    src.getRecords(conn, recFrom, toEnd, [...settleSet]),
    src.getInvoices(conn, recFrom, toEnd).catch(err => { warnings.push(`[${conn.name}] Счета на оплату не загружены: ${err.message}`); return []; }),
    src.getClients(conn).catch(err => { warnings.push(`[${conn.name}] Контрагенты не загружены: ${err.message}`); return []; }),
    src.getUsers(conn).catch(err => { warnings.push(`[${conn.name}] Пользователи 1С не загружены: ${err.message}`); return []; }),
  ]);


  const clientInfo = new Map(clientsRaw.map(c => [c.Ref_Key, c]));
  const userName = new Map(usersRaw.map(u => [u.Ref_Key, u.Description]));

  const clients = new Map();
  const C = key => {
    if (!clients.has(key)) {
      const info = clientInfo.get(key);
      clients.set(key, {
        id: conn.id + ':' + key,
        company: conn.name,
        name: info?.Description || (key === EMPTY ? '(без контрагента)' : `Контрагент ${key.slice(0, 8)}`),
        bin: info?.ИдентификационныйКодЛичности || '',
        invoicesCount: 0, invoicesSum: 0, accrued: 0, paid: 0, owner: '',
        debt: 0, advance: 0, overdue: 0, maxDaysOverdue: 0, lastPayment: null,
        aging: emptyAging(), managers: new Set(),
      });
    }
    return clients.get(key);
  };

  // 3. Остатки: долг (Дт 1210) и авансы (Кт 3510 и переплата по 1210)
  for (const row of bal.rows) {
    const key = balanceClientRef(row);
    // Развёрнутое сальдо: дебетовая часть всегда долг, кредитовая часть всегда аванс/переплата
    const hasSplit = row[`${config.regResource}SplittedBalanceDr`] !== undefined;
    const dr = hasSplit ? res(row, 'SplittedBalanceDr') : Math.max(res(row, 'BalanceDr'), 0);
    const cr = hasSplit ? res(row, 'SplittedBalanceCr') : Math.max(res(row, 'BalanceCr'), 0);
    if (recvSet.has(row.Account_Key)) {
      if (dr) C(key).debt += dr;
      if (cr) C(key).advance += cr;
    } else if (advSet.has(row.Account_Key)) {
      if (cr) C(key).advance += cr;
      if (dr) C(key).advance -= dr;
    }
  }

  // 4. Проводки: начисления и оплаты за период, начисления для FIFO
  const fromIso = isoLocal(from);
  const accruals = new Map(); // client -> [{date, sum}]
  for (const r of records) {
    const p = String(r.Period);
    const sum = Number(r[config.regResource]) || 0;
    const drSettle = settleSet.has(r.AccountDr_Key);
    const crSettle = settleSet.has(r.AccountCr_Key);
    // Начисление: Дт 1210, Кт не расчётный счёт (выручка и т.п.)
    if (recvSet.has(r.AccountDr_Key) && !crSettle) {
      const key = clientRef(r, 'Dr');
      if (!accruals.has(key)) accruals.set(key, []);
      accruals.get(key).push({ date: p, sum });
      if (p >= fromIso) C(key).accrued += sum;
    }
    // Оплата: Кт 1210/3510, Дт не расчётный (касса, банк, Kaspi)
    if (crSettle && !drSettle) {
      const key = clientRef(r, 'Cr');
      const c = C(key);
      if (p >= fromIso) c.paid += sum;
      if (!c.lastPayment || p > c.lastPayment) c.lastPayment = p;
    }
  }

  // 5. Возраст долга по FIFO: остаток долга закрывает самые свежие начисления, остальное считается оплаченным
  const today = Math.min(Date.now(), asOf.getTime());
  for (const c of clients.values()) {
    let left = c.debt;
    if (left <= 0.01) continue;
    const list = (accruals.get(c.id.slice(c.id.indexOf(':') + 1)) || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    for (const a of list) {
      if (left <= 0.01) break;
      const part = Math.min(left, a.sum);
      left -= part;
      const due = new Date(a.date).getTime() + config.paymentTermDays * DAY;
      const days = Math.floor((today - due) / DAY);
      c.aging[bucketOf(days)] += part;
      if (days > 0) {
        c.overdue += part;
        c.maxDaysOverdue = Math.max(c.maxDaysOverdue, days);
      }
    }
    if (left > 0.01) {
      // Долг старше глубины просмотра
      c.aging.d90 += left;
      c.overdue += left;
      c.maxDaysOverdue = Math.max(c.maxDaysOverdue, config.agingLookbackMonths * 30);
    }
  }

  // 6. Счета на оплату за период
  const managers = new Map();
  const fromDay = isoLocal(from).slice(0, 10);
  // Ответственный клиента: менеджер его последнего счёта за всё время просмотра (не только за период)
  const lastInv = new Map();
  for (const i of invoicesRaw) {
    if (i.DeletionMark === true) continue;
    const k = i.Контрагент_Key || EMPTY;
    const cur = lastInv.get(k);
    if (!cur || String(i.Date) > String(cur.Date)) lastInv.set(k, i);
  }
  for (const [k, i] of lastInv) C(k).owner = userName.get(i.Ответственный_Key) || '';
  const invoices = invoicesRaw
    .filter(i => i.DeletionMark !== true && String(i.Date).slice(0, 10) >= fromDay)
    .map(i => {
      const sum = Number(i.СуммаДокумента) || 0;
      const manager = userName.get(i.Ответственный_Key) || '(не указан)';
      const c = C(i.Контрагент_Key || EMPTY);
      c.invoicesCount++;
      c.invoicesSum += sum;
      c.managers.add(manager);
      const m = managers.get(manager) || { name: manager, company: conn.name, invoicesCount: 0, invoicesSum: 0, clients: new Set() };
      m.invoicesCount++;
      m.invoicesSum += sum;
      m.clients.add(i.Контрагент_Key || EMPTY);
      managers.set(manager, m);
      return {
        id: i.Ref_Key, number: String(i.Number || '').trim(), date: i.Date, sum,
        clientId: c.id, client: c.name, company: conn.name, manager, posted: i.Posted !== false,
        comment: i.Комментарий || '',
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // Долг и просрочка по менеджеру = по его клиентам
  for (const m of managers.values()) {
    m.debt = 0; m.overdue = 0;
    for (const id of m.clients) {
      const c = clients.get(id);
      m.debt += c.debt; m.overdue += c.overdue;
    }
  }

  // 7. Итоги
  const clientList = [...clients.values()]
    .filter(c => c.invoicesCount || c.accrued || c.paid || c.debt > 0.01 || Math.abs(c.advance) > 0.01)
    .map(c => ({
      ...c,
      managers: [...c.managers],
      invoicesSum: round(c.invoicesSum), accrued: round(c.accrued), paid: round(c.paid),
      debt: round(c.debt), advance: round(c.advance), overdue: round(c.overdue),
      aging: Object.fromEntries(Object.entries(c.aging).map(([k, v]) => [k, round(v)])),
    }))
    .sort((a, b) => b.overdue - a.overdue || b.debt - a.debt);

  const sum = f => round(clientList.reduce((s, c) => s + (f(c) || 0), 0));
  const aging = BUCKETS.map(b => ({ id: b.id, label: b.label, sum: sum(c => c.aging[b.id]) }));

  return {
    generatedAt: new Date().toISOString(),
    source: config.mock ? 'mock' : '1c',
    period: { from: isoLocal(from).slice(0, 10), to: isoLocal(to).slice(0, 10) },
    settings: { paymentTermDays: config.paymentTermDays, receivable: config.accReceivable, advances: config.accAdvances },
    totals: {
      invoicesCount: invoices.length,
      invoicesSum: round(invoices.reduce((s, i) => s + i.sum, 0)),
      accrued: sum(c => c.accrued),
      paid: sum(c => c.paid),
      debt: sum(c => c.debt),
      overdue: sum(c => c.overdue),
      advances: sum(c => Math.max(c.advance, 0)),
      debtorsCount: clientList.filter(c => c.debt > 0.01).length,
      overdueCount: clientList.filter(c => c.overdue > 0.01).length,
    },
    aging,
    clients: clientList,
    managers: [...managers.values()]
      .map(m => ({ name: m.name, invoicesCount: m.invoicesCount, invoicesSum: round(m.invoicesSum), clientsCount: m.clients.size, debt: round(m.debt), overdue: round(m.overdue) }))
      .sort((a, b) => b.invoicesSum - a.invoicesSum),
    invoices,
    warnings,
  };
}

// companyId: id компании, либо 'all' (обе вместе)
export async function buildReport({ from, to, company = 'all' }) {
  const list = company === 'all' ? companies : companies.filter(c => c.id === company);
  if (!list.length) throw new Error('Неизвестная компания');
  if (list.length === 1) return { ...(await buildCompanyReport(list[0], { from, to })), company: list[0].id };

  // Считаем компании независимо: одна недоступная база не должна ронять вторую
  const settled = await Promise.allSettled(list.map(c => buildCompanyReport(c, { from, to })));
  const parts = [];
  const warnings = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') parts.push(r.value);
    else warnings.push(`[${list[i].name}] не загружена: ${r.reason?.message || r.reason}`);
  });
  if (!parts.length) throw new Error(warnings.join('; '));

  const r2 = n => Math.round(n * 100) / 100;
  const sumKey = k => r2(parts.reduce((a, p) => a + p.totals[k], 0));
  const clients = parts.flatMap(p => p.clients).sort((a, b) => b.overdue - a.overdue || b.debt - a.debt);
  const invoices = parts.flatMap(p => p.invoices).sort((a, b) => b.date.localeCompare(a.date));
  // Менеджеры из разных баз с одинаковым именем объединяем
  const mm = new Map();
  for (const m of parts.flatMap(p => p.managers)) {
    const x = mm.get(m.name) || { name: m.name, invoicesCount: 0, invoicesSum: 0, clientsCount: 0, debt: 0, overdue: 0 };
    x.invoicesCount += m.invoicesCount; x.invoicesSum = r2(x.invoicesSum + m.invoicesSum);
    x.clientsCount += m.clientsCount; x.debt = r2(x.debt + m.debt); x.overdue = r2(x.overdue + m.overdue);
    mm.set(m.name, x);
  }
  return {
    generatedAt: new Date().toISOString(),
    source: parts[0].source,
    company: 'all',
    period: parts[0].period,
    settings: parts[0].settings,
    totals: {
      invoicesCount: sumKey('invoicesCount'), invoicesSum: sumKey('invoicesSum'), accrued: sumKey('accrued'),
      paid: sumKey('paid'), debt: sumKey('debt'), overdue: sumKey('overdue'), advances: sumKey('advances'),
      debtorsCount: sumKey('debtorsCount'), overdueCount: sumKey('overdueCount'),
    },
    aging: BUCKETS.map(b => ({ id: b.id, label: b.label, sum: r2(parts.reduce((a, p) => a + (p.aging.find(x => x.id === b.id)?.sum || 0), 0)) })),
    clients,
    managers: [...mm.values()].sort((a, b) => b.invoicesSum - a.invoicesSum),
    invoices,
    byCompany: parts.map(p => ({ name: p.clients[0]?.company || '', totals: p.totals })),
    warnings: [...warnings, ...parts.flatMap(p => p.warnings)],
  };
}

function isoLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- Ограничение отчёта по роли ----------
const toks = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
// "Иванов Иван" и "Иван Иванов Петрович" считаем одним человеком
export function sameName(a, b) {
  const x = toks(a), y = toks(b);
  if (x.length < 2 || y.length < 2) return false;
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  return small.every(w => big.includes(w));
}

// Оставляет клиентов, прошедших keepClient, и счета, прошедшие keepInvoice, и пересчитывает итоги
export function scopeReport(rep, keepClient, keepInvoice = i => true) {
  const clients = rep.clients.filter(keepClient);
  const ids = new Set(clients.map(c => c.id));
  const invoices = rep.invoices.filter(i => ids.has(i.clientId) && keepInvoice(i));
  const sum = f => round(clients.reduce((s, c) => s + (f(c) || 0), 0));
  const mm = new Map();
  for (const i of invoices) {
    const m = mm.get(i.manager) || { name: i.manager, invoicesCount: 0, invoicesSum: 0, clients: new Set() };
    m.invoicesCount++; m.invoicesSum += i.sum; m.clients.add(i.clientId); mm.set(i.manager, m);
  }
  const byId = new Map(clients.map(c => [c.id, c]));
  return {
    ...rep,
    clients, invoices,
    totals: {
      ...rep.totals,
      invoicesCount: invoices.length, invoicesSum: round(invoices.reduce((s, i) => s + i.sum, 0)),
      accrued: sum(c => c.accrued), paid: sum(c => c.paid), debt: sum(c => c.debt), overdue: sum(c => c.overdue),
      advances: sum(c => Math.max(c.advance, 0)),
      debtorsCount: clients.filter(c => c.debt > 0.01).length, overdueCount: clients.filter(c => c.overdue > 0.01).length,
    },
    aging: BUCKETS.map(b => ({ id: b.id, label: b.label, sum: sum(c => c.aging[b.id]) })),
    managers: [...mm.values()].map(m => {
      let debt = 0, overdue = 0;
      for (const id of m.clients) { const c = byId.get(id); if (c) { debt += c.debt; overdue += c.overdue; } }
      return { name: m.name, invoicesCount: m.invoicesCount, invoicesSum: round(m.invoicesSum), clientsCount: m.clients.size, debt: round(debt), overdue: round(overdue) };
    }).sort((a, b) => b.invoicesSum - a.invoicesSum),
    byCompany: undefined,
  };
}
