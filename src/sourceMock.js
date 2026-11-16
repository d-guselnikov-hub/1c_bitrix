// Фейковый источник с той же формой данных, что отдаёт 1С. Нужен, чтобы проверить интерфейс без 1С.
const ACC = {
  '1210': '00000000-0000-0000-0000-000000001210',
  '3510': '00000000-0000-0000-0000-000000003510',
  '6010': '00000000-0000-0000-0000-000000006010',
  '1010': '00000000-0000-0000-0000-000000001010',
  '1030': '00000000-0000-0000-0000-000000001030',
};
const T_CLIENT = 'StandardODATA.Catalog_Контрагенты';

const NAMES = [
  'ТОО "Алтын Құрылыс"', 'ИП Ахметов Б.С.', 'ТОО "КазСтройИнвест"', 'ТОО "Нур Логистик"', 'ИП Сейткали А.М.',
  'ТОО "Жетысу Агро"', 'ТОО "Тау Медиа"', 'ИП Ким Д.В.', 'ТОО "Астана Трейд Групп"', 'ТОО "Береке Фарм"',
  'ИП Нурланова Г.К.', 'ТОО "Самрук Сервис"', 'ТОО "Алматы Энерго Монтаж"', 'ИП Петров А.А.', 'ТОО "Қазақ Тамақ"',
  'ТОО "Steppe Digital"', 'ИП Жумабаева С.Т.', 'ТОО "Орал Транс"', 'ТОО "Медеу Девелопмент"', 'ИП Ибраев Р.Е.',
  'ТОО "Silk Road Cargo"', 'ТОО "Шымкент Пласт"',
];
const MANAGERS = ['Абенова Айгерим', 'Смагулов Ерлан', 'Ли Виктория', 'Оспанов Данияр'];

// Детерминированный генератор, чтобы цифры не прыгали между обновлениями
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const uid = (p, i) => `${p}-0000-0000-0000-${String(i).padStart(12, '0')}`;

const caches = new Map();
function generate(conn) {
  const id = conn?.id || 'x';
  if (caches.has(id)) return caches.get(id);
  let seed = 0; for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const r = rng(42 + seed % 1000);
  const clients = NAMES.map((n, i) => ({
    Ref_Key: uid('c0000000', i + 1), Description: n,
    ИдентификационныйКодЛичности: String(100000000000 + Math.floor(r() * 899999999999)),
  }));
  const users = MANAGERS.map((n, i) => ({ Ref_Key: uid('a0000000', i + 1), Description: n }));
  const records = [];
  const invoices = [];
  const now = new Date();
  let invNo = 1;

  clients.forEach((c, ci) => {
    const fee = Math.round((80 + r() * 520) / 5) * 5 * 1000; // абонплата 80к..600к
    const discipline = r(); // 0 - плохой плательщик, 1 - хороший
    const startMonth = 3 + Math.floor(r() * 12);
    const manager = users[ci % users.length];
    for (let m = startMonth; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1 + Math.floor(r() * 14), 10);
      if (d > now) continue;
      invoices.push({
        Ref_Key: uid('d0000000', invNo), Number: `СЧ-${String(invNo).padStart(5, '0')}`, Date: iso(d),
        Контрагент_Key: c.Ref_Key, СуммаДокумента: fee, Ответственный_Key: manager.Ref_Key,
        Posted: true, DeletionMark: false,
      });
      invNo++;
      records.push({
        Period: iso(d), Active: true, AccountDr_Key: ACC['1210'], AccountCr_Key: ACC['6010'],
        ExtDimensionDr1: c.Ref_Key, ExtDimensionDr1_Type: T_CLIENT, Сумма: fee,
      });
      // Оплата: хорошие платят почти сразу, плохие с задержкой или не платят
      const skip = discipline < 0.25 ? r() < 0.6 : discipline < 0.5 ? r() < 0.25 : r() < 0.04;
      if (skip) continue;
      const delay = discipline > 0.6 ? Math.floor(r() * 7) : Math.floor(r() * 60);
      const pd = new Date(d.getTime() + delay * 86400000);
      if (pd > now) continue;
      const part = r() < 0.12 ? 0.5 : 1;
      records.push({
        Period: iso(pd), Active: true, AccountDr_Key: r() < 0.5 ? ACC['1010'] : ACC['1030'], AccountCr_Key: ACC['1210'],
        ExtDimensionCr1: c.Ref_Key, ExtDimensionCr1_Type: T_CLIENT, Сумма: fee * part,
      });
    }
    // Пара клиентов с авансом
    if (ci % 7 === 3) {
      records.push({
        Period: iso(new Date(now.getTime() - 3 * 86400000)), Active: true, AccountDr_Key: ACC['1030'], AccountCr_Key: ACC['3510'],
        ExtDimensionCr1: c.Ref_Key, ExtDimensionCr1_Type: T_CLIENT, Сумма: fee,
      });
    }
  });
  records.sort((a, b) => a.Period.localeCompare(b.Period));
  const out = { clients, users, records, invoices };
  caches.set(id, out);
  return out;
}

function iso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const inRange = (s, from, to) => s >= iso(from) && s <= iso(to);

export async function getAccounts(conn) {
  return Object.entries(ACC).map(([Code, Ref_Key]) => ({ Ref_Key, Code, Parent_Key: '00000000-0000-0000-0000-000000000000' }));
}

export async function getBalance(conn, asOf, accountKeys) {
  const { records } = generate(conn);
  const keys = new Set(accountKeys);
  const map = new Map();
  for (const r of records) {
    if (r.Period >= iso(asOf)) continue;
    if (keys.has(r.AccountDr_Key)) add(map, r.AccountDr_Key, r.ExtDimensionDr1, r.ExtDimensionDr1_Type, r.Сумма);
    if (keys.has(r.AccountCr_Key)) add(map, r.AccountCr_Key, r.ExtDimensionCr1, r.ExtDimensionCr1_Type, -r.Сумма);
  }
  const rows = [...map.values()].map(x => ({
    Account_Key: x.acc, ExtDimension1: x.ext, ExtDimension1_Type: x.type,
    СуммаBalance: x.sum, СуммаBalanceDr: x.sum > 0 ? x.sum : 0, СуммаBalanceCr: x.sum < 0 ? -x.sum : 0,
    СуммаSplittedBalanceDr: x.sum > 0 ? x.sum : 0, СуммаSplittedBalanceCr: x.sum < 0 ? -x.sum : 0,
  }));
  return { rows, filtered: true };
}
function add(map, acc, ext, type, sum) {
  const k = `${acc}|${ext}`;
  const cur = map.get(k) || { acc, ext, type, sum: 0 };
  cur.sum += sum;
  map.set(k, cur);
}

export async function getRecords(conn, from, to) {
  return generate(conn).records.filter(r => inRange(r.Period, from, to));
}
export async function getInvoices(conn, from, to) {
  return generate(conn).invoices.filter(i => inRange(i.Date, from, to));
}
export async function getClients(conn) { return generate(conn).clients; }
export async function getUsers(conn) { return generate(conn).users; }
