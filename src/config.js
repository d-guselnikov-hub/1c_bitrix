import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Простой загрузчик .env без зависимостей
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const e = (k, d = '') => (process.env[k] ?? d).toString().trim();
const list = (k, d = '') => e(k, d).split(',').map(s => s.trim()).filter(Boolean);
const num = (k, d) => {
  const n = Number(e(k, String(d)));
  return Number.isFinite(n) ? n : d;
};

export const config = {
  root,
  port: num('PORT', 3010),
  sessionSecret: e('SESSION_SECRET', 'change_me'),

  bitrixDomain: e('BITRIX_DOMAIN', 'myarbitr.bitrix24.kz').toLowerCase(),

  odataUrl: e('ODATA_URL').replace(/\/+$/, ''),
  odataUser: e('ODATA_USER'),
  odataPassword: e('ODATA_PASSWORD'),

  regAccounting: e('REG_ACCOUNTING', 'AccountingRegister_Типовой'),
  chartOfAccounts: e('CHART_OF_ACCOUNTS', 'ChartOfAccounts_Типовой'),
  regResource: e('REG_RESOURCE', 'Сумма'),
  docInvoice: e('DOC_INVOICE', 'Document_СчетНаОплатуПокупателю'),
  catClients: e('CAT_CLIENTS', 'Catalog_Контрагенты'),
  catUsers: e('CAT_USERS', 'Catalog_Пользователи'),

  accReceivable: list('ACC_RECEIVABLE', '1210'),
  accAdvances: list('ACC_ADVANCES', '3510'),

  paymentTermDays: num('PAYMENT_TERM_DAYS', 5),
  agingLookbackMonths: num('AGING_LOOKBACK_MONTHS', 24),
  cacheTtlMs: num('CACHE_TTL_MIN', 10) * 60 * 1000,

  mock: e('MOCK') === '1',
  devNoAuth: e('DEV_NO_AUTH') === '1',
};

// Компании: CO1_NAME, CO1_ODATA_URL, CO1_ODATA_USER, CO1_ODATA_PASSWORD, CO2_... (до 9)
export const companies = [];
for (let i = 1; i <= 9; i++) {
  const p = `CO${i}_`;
  const name = e(p + 'NAME');
  if (!name) continue;
  companies.push({
    id: e(p + 'ID', 'c' + i), name,
    url: e(p + 'ODATA_URL').replace(/\/+$/, ''), user: e(p + 'ODATA_USER'), password: e(p + 'ODATA_PASSWORD'),
  });
}
// Старый формат с одной базой
if (!companies.length && config.odataUrl) {
  companies.push({ id: 'main', name: '1С', url: config.odataUrl, user: config.odataUser, password: config.odataPassword });
}
// Ничего не настроено: тестовый режим с двумя компаниями
if (!companies.length) {
  console.warn('[config] Базы 1С не настроены. Включаю MOCK-режим.');
  config.mock = true;
  companies.push({ id: 'moy', name: 'Мой арбитр' }, { id: 'arbitr', name: 'АрбитрЪ' });
}
if (companies.some(c => !c.url) && !config.mock) {
  console.warn('[config] У компаний без ODATA_URL запросы будут возвращать ошибку: ' + companies.filter(c => !c.url).map(c => c.name).join(', '));
}
if (config.sessionSecret === 'change_me') {
  console.warn('[config] SESSION_SECRET не задан, используется значение по умолчанию. Задай свой в .env');
}
