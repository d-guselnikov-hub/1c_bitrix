// Филиал клиента определяется по воронке его последней сделки в Битриксе.
// Строим индекс «имя клиента» -> филиал, обновляем раз в час и сохраняем в data/branch-index.json.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { bx, bxAll, bitrixEnabled } from './bitrixApi.js';

const file = path.join(config.root, 'data', 'branch-index.json');
const TTL = 60 * 60 * 1000;

// "2.5. ФОП. Караганда" -> Караганда, "1.2. Филиал. Алматы НУР" -> Алматы, "1. Голова. ..." -> Голова
export function branchOfFunnel(name) {
  const n = String(name || '').trim();
  let m = /^\d+(?:\.\d+)?\.\s*(?:Филиал|ФОП)\.\s*(.+)$/i.exec(n);
  if (m) return m[1].trim().split(/\s+/)[0];
  if (/^\d+(?:\.\d+)?\.\s*Голова/i.test(n)) return 'Голова';
  if (/^\d+(?:\.\d+)?\.\s*БЮЛ/i.test(n)) return 'БЮЛ';
  return '';
}

// Название отдела Битрикса -> филиал ("Нур", "Абая", "Филиал Астана", "Астана-2", "У-ка" ...)
const DEPT = [[/нур|абая|зел[её]н|алматы/i, 'Алматы'], [/астана/i, 'Астана'], [/актобе/i, 'Актобе'], [/семей/i, 'Семей'],
  [/у-ка|усть/i, 'Усть-Каменогорск'], [/атырау/i, 'Атырау'], [/шымкент/i, 'Шымкент'], [/туркестан/i, 'Туркестан'],
  [/кокшетау/i, 'Кокшетау'], [/караганд/i, 'Караганда'], [/павлодар/i, 'Павлодар'], [/актау/i, 'Актау'], [/сарыагаш/i, 'Сарыагаш'],
  [/головн|голова/i, 'Голова']];
export function branchOfDept(name) { const m = DEPT.find(([re]) => re.test(String(name || ''))); return m ? m[1] : ''; }
function branchOfDepts(ids, map) { for (const id of ids) { const b = map.get(String(id)); if (b) return b; } return ''; }

export const nameKey = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1).sort().join(' ');
const twoKey = s => { const w = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(x => x.length > 1); return w.length >= 2 ? w.slice(0, 2).sort().join(' ') : ''; };

let index = null;
let building = null;

async function build() {
  const cats = (await bx('crm.category.list', { entityTypeId: 2 })).result?.categories || [];
  const funnelBranch = new Map(cats.map(c => [String(c.id), branchOfFunnel(c.name)]));
  // воронка «Основная» (id 0) в списке тоже есть, но филиала не даёт

  const deals = await bxAll('crm.deal.list', { select: ['ID', 'CATEGORY_ID', 'CONTACT_ID', 'COMPANY_ID', 'ASSIGNED_BY_ID'], order: { ID: 'ASC' } });
  const contacts = await bxAll('crm.contact.list', { select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'] });
  const companies = await bxAll('crm.company.list', { select: ['ID', 'TITLE'] });
  const users = await bxAll('user.get', { filter: { ACTIVE: true } });
  const depts = await bxAll('department.get', {});

  const contactName = new Map(contacts.map(c => [String(c.ID), [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ')]));
  const companyName = new Map(companies.map(c => [String(c.ID), c.TITLE]));
  const byFull = {}, byTwo = {};
  for (const d of deals) { // по возрастанию ID: поздняя сделка перезаписывает раннюю
    const br = funnelBranch.get(String(d.CATEGORY_ID));
    if (!br) continue;
    const names = [contactName.get(String(d.CONTACT_ID)), companyName.get(String(d.COMPANY_ID))].filter(Boolean);
    for (const n of names) {
      const v = [br, String(d.ASSIGNED_BY_ID || ''), String(d.ID)];
      const k = nameKey(n); if (k) byFull[k] = v;
      const t = twoKey(n); if (t) byTwo[t] = v;
    }
  }
  const deptBranch = new Map(depts.map(d => [String(d.ID), branchOfDept(d.NAME)]));
  const idx = {
    builtAt: Date.now(),
    branches: [...new Set([...funnelBranch.values()].filter(Boolean))].sort(),
    byFull, byTwo,
    users: users.map(u => ({ id: String(u.ID), name: [u.LAST_NAME, u.NAME].filter(Boolean).join(' '), branch: branchOfDepts(u.UF_DEPARTMENT || [], deptBranch) })),
    stats: { deals: deals.length, contacts: contacts.length, companies: companies.length },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(idx));
  return idx;
}

function load() {
  if (index) return index;
  try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла */ }
  return index;
}

export async function getBranchIndex({ force = false } = {}) {
  if (!bitrixEnabled()) return null;
  const cur = load();
  const fresh = cur && Date.now() - cur.builtAt < TTL;
  if (fresh && !force) return cur;
  if (!building) {
    building = build().then(i => { index = i; return i; }).finally(() => { building = null; });
  }
  // устаревший индекс отдаём сразу, а обновляем в фоне; пустой — ждём
  return cur && !force ? cur : building;
}

// -> { branch, userId } по имени клиента, пустые значения, если сделок нет
export function branchOfClient(idx, name) {
  if (!idx) return { branch: '', userId: '', dealId: '' };
  const two = String(name).split(/\s+/).slice(0, 2).join(' ');
  const v = idx.byFull[nameKey(name)] || idx.byFull[nameKey(two)] || idx.byTwo[twoKey(name)];
  return v ? { branch: Array.isArray(v) ? v[0] : v, userId: Array.isArray(v) ? v[1] : '', dealId: Array.isArray(v) ? v[2] || '' : '' } : { branch: '', userId: '', dealId: '' };
}

// Филиал менеджера (по его отделу в Битриксе)
export function branchOfManager(idx, name) {
  if (!idx || !name) return '';
  const toks = x => String(x).toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
  const n = toks(name);
  const u = idx.users.find(u => { const t = toks(u.name); const [a, b] = t.length <= n.length ? [t, n] : [n, t]; return a.length >= 2 && a.every(w => b.includes(w)); });
  return u?.branch || branchOfDept(name);
}
