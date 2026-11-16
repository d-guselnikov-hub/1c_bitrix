// Источник данных: реальная 1С через OData
import { config } from './config.js';
import { odataGet, odataGetAll, dt, toLocalIso } from './odata.js';

const guid = k => `guid'${k}'`;

export async function getAccounts(conn) {
  // Ref_Key, Code, Parent_Key
  try {
    return await odataGetAll(conn, config.chartOfAccounts, { $select: 'Ref_Key,Code,Parent_Key,Description' });
  } catch {
    return await odataGetAll(conn, config.chartOfAccounts);
  }
}

// Остатки на момент asOf по указанным счетам
export async function getBalance(conn, asOf, accountKeys) {
  // Условие Condition в OData этой конфигурации не принимает поле Account_Key, поэтому берём все остатки
  // на дату одним запросом (их немного) и фильтруем по нужным счетам сами.
  const period = `Period=datetime'${toLocalIso(asOf)}'`;
  const rows = await odataGetAll(conn, `${config.regAccounting}/Balance(${period})`);
  const set = new Set(accountKeys);
  return { rows: rows.filter(r => set.has(r.Account_Key)), filtered: false };
}

// Проводки с субконто (виртуальная таблица RecordsWithExtDimensions), оставляем те, где участвуют нужные счета
export async function getRecords(conn, from, to, accountKeys) {
  const entity = `${config.regAccounting}/RecordsWithExtDimensions(StartPeriod=${dt(from)},EndPeriod=${dt(to)})`;
  const rows = await odataGetAll(conn, entity);
  const set = new Set(accountKeys);
  return rows
    .filter(r => r.Active !== false && (set.has(r.AccountDr_Key) || set.has(r.AccountCr_Key)))
    .sort((a, b) => String(a.Period).localeCompare(String(b.Period)));
}

export async function getInvoices(conn, from, to) {
  const filter = `Date ge ${dt(from)} and Date le ${dt(to)} and DeletionMark eq false`;
  return odataGetAll(conn, config.docInvoice, { $filter: filter });
}

export async function getClients(conn) {
  try {
    return await odataGetAll(conn, config.catClients, { $select: 'Ref_Key,Description,ИдентификационныйКодЛичности,IsFolder' });
  } catch {
    return await odataGetAll(conn, config.catClients, { $select: 'Ref_Key,Description' });
  }
}

export async function getUsers(conn) {
  return odataGetAll(conn, config.catUsers, { $select: 'Ref_Key,Description' });
}
