import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { buildReport } from './report.js';
import { companies } from './config.js';
import { runReminders, startReminders } from './reminders.js';
import { getBranchIndex, branchOfClient, branchOfManager } from './branches.js';
import { scopeReport, sameName } from './report.js';
import { verifyBitrixLaunch, signSession, readSession } from './bitrix.js';
import { preview as invPreview, createInvoice, loadDeal } from './invoicing.js';
import { readAccess, writeAccess, isAdmin, isAllowed, userScope, ROLES, ROOT_ADMIN } from './access.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Разрешаем показ только во фрейме нашего портала
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors https://${config.bitrixDomain}`);
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const publicDir = path.join(config.root, 'public');
const indexHtml = () => fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderApp(res, user) {
  const boot = JSON.stringify({ session: signSession(user), user: user.name, mock: config.mock, companies: visibleCompanies(user.id).map(c => ({ id: c.id, name: c.name })), portal: config.bitrixDomain, admin: isAdmin(user.id), role: userScope(user.id)?.role || '' }).replace(/</g, '\\u003c');
  // Версия файлов в адресе, чтобы Битрикс/браузер не держал старый app.js после обновления
  const ver = f => { try { return Math.floor(fs.statSync(path.join(publicDir, f)).mtimeMs); } catch { return 0; } };
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(indexHtml().replace('/*__BOOT__*/', `window.__BOOT__ = ${boot};`)
    .replace('/static/app.js', `/static/app.js?v=${ver('app.js')}`)
    .replace('/static/style.css', `/static/style.css?v=${ver('style.css')}`));
}

function renderError(res, status, msg) {
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:32px;color:#333">
    <h3 style="margin:0 0 8px">Сводка 1С недоступна</h3><div>${esc(msg)}</div></body>`);
}

// Точка входа из Битрикс24 (POST при открытии приложения)
async function launch(req, res) {
  if (config.devNoAuth) return renderApp(res, { id: '30833', name: 'Локальный режим' });
  try {
    const user = await verifyBitrixLaunch(req);
    renderApp(res, user);
  } catch (err) {
    renderError(res, 403, err.message);
  }
}
app.post('/', launch);
app.get('/', launch);
app.post('/install', (req, res) => {
  // Установка локального приложения: просто завершаем её на стороне Битрикса
  res.type('html').send(`<!doctype html><meta charset="utf-8"><script src="https://api.bitrix24.com/api/v1/"></script>
    <script>BX24.init(function(){ BX24.installFinish(); });</script>Установка...`);
});


// ---- Вкладка «Выставить счёт» в карточке сделки (placement) ----
async function placementLaunch(req, res) {
  try {
    const user = config.devNoAuth ? { id: '30833', name: 'Локальный режим' } : await verifyBitrixLaunch(req);
    let opts = req.body?.PLACEMENT_OPTIONS || req.query.PLACEMENT_OPTIONS || '{}';
    try { opts = typeof opts === 'string' ? JSON.parse(opts) : opts; } catch { opts = {}; }
    const dealId = String(opts.ID || '').replace(/\D/g, '');
    if (!dealId) throw new Error('Не удалось определить сделку');
    const boot = JSON.stringify({ session: signSession(user), dealId }).replace(/</g, '\\u003c');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(fs.readFileSync(path.join(publicDir, 'placement.html'), 'utf8').replace('/*__BOOT__*/', `window.__BOOT__ = ${boot};`));
  } catch (err) { renderError(res, 403, err.message); }
}
app.post('/placement/deal', placementLaunch);
app.get('/placement/deal', placementLaunch);

// Выставлять счета могут админ, директор филиала и менеджер (только по своим сделкам)
async function requireInvoiceRight(req, res, next) {
  const sc = userScope(req.user.id);
  if (!sc) return res.status(403).json({ error: 'Нет прав на выставление счетов' });
  if (sc.role === 'manager') {
    try {
      const { deal } = await loadDeal(String(req.body.dealId));
      if (String(deal.ASSIGNED_BY_ID) !== String(req.user.id)) return res.status(403).json({ error: 'Менеджер выставляет счета только по своим сделкам' });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  next();
}
const invalidDeal = (req, res, next) => /^\d+$/.test(String(req.body?.dealId || '')) ? next() : res.status(400).json({ error: 'Неверный номер сделки' });
app.post('/api/invoice/preview', requireSession, invalidDeal, requireInvoiceRight, async (req, res) => {
  try { res.json(await invPreview(String(req.body.dealId))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/invoice/create', requireSession, invalidDeal, requireInvoiceRight, async (req, res) => {
  try { console.log(`[invoice] user=${req.user.id} deal=${req.body.dealId} amount=${req.body.amount}`); res.json(await createInvoice(String(req.body.dealId), req.body)); }
  catch (e) { console.error('[invoice] error', e.message); res.status(400).json({ error: e.message }); }
});

app.use('/static', express.static(publicDir, { index: false, maxAge: '1h' }));

// Компании с флагом adminOnly видят только администраторы приложения
function visibleCompanies(id) { return isAdmin(id) ? companies : companies.filter(c => !c.adminOnly); }

// ---- API ----
function requireSession(req, res, next) {
  const user = config.devNoAuth ? { id: '30833' } : readSession(req.get('X-Session'));
  if (!user) return res.status(401).json({ error: 'Сессия истекла, открой приложение заново' });
  // Список доступа проверяем на каждом запросе: убранный сотрудник теряет доступ сразу
  if (!isAllowed(user.id)) return res.status(403).json({ error: 'Доступ к отчёту закрыт' });
  req.user = user;
  next();
}

const cache = new Map();
const inflight = new Map();

function parseDate(s, fallback) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : fallback;
}

// Филиал клиента и ограничение отчёта по роли пользователя
function applyScope(rep, scope, idx, branchFilter) {
  const clients = rep.clients.map(c => {
    const b = branchOfClient(idx, c.name);
    const k = b.dealId ? idx?.contracts?.[b.dealId] : null;
    const contract = k ? { sum: k.sum, paid: k.paid, left: Math.max(0, k.sum - k.paid), overdue: k.overdue, overdueCount: k.overdueCount, next: k.next, nextSum: k.nextSum } : null;
    return { ...c, branch: b.branch || branchOfManager(idx, c.owner) || '', bxUser: b.userId, dealId: b.dealId, bxEntity: b.entity, contract,
      contractLeft: contract ? contract.left : null, contractOverdue: contract ? contract.overdue : null, nextPay: contract?.next || '' };
  });
  const branchList = [...new Set(clients.map(c => c.branch).filter(Boolean))].sort();
  let out = { ...rep, clients, branches: branchList, role: scope?.role };
  const byId = new Map(clients.map(c => [c.id, c]));
  // Счёт, выставленный из сделки через приложение, ведёт в свою сделку; остальные в последнюю сделку клиента
  out.invoices = rep.invoices.map(i => {
    const c = byId.get(i.clientId);
    const own = /Сделка Битрикс24 #(\d+)/.exec(i.comment || '')?.[1];
    return { ...i, branch: c?.branch || '', dealId: own || c?.dealId || '', bxEntity: c?.bxEntity || '' };
  });
  if (!scope) return { ...out, clients: [], invoices: [] };
  if (scope.role === 'director') {
    const set = new Set(scope.branches);
    out = scopeReport(out, c => set.has(c.branch));
    out.branches = branchList.filter(b => set.has(b));
  } else if (scope.role === 'manager') {
    out = scopeReport(out, c => (scope.id && c.bxUser === scope.id) || sameName(c.owner, scope.name) || c.managers.some(m => sameName(m, scope.name)), i => sameName(i.manager, scope.name) || byId.get(i.clientId)?.bxUser === scope.id);
    out.branches = [];
  } else if (branchFilter) {
    out = scopeReport(out, c => (branchFilter === '-' ? !c.branch : c.branch === branchFilter));
  }
  out.role = scope.role;
  return out;
}

app.get('/api/report', requireSession, async (req, res) => {
  const now = new Date();
  const from = parseDate(req.query.from, new Date(now.getFullYear(), now.getMonth(), 1));
  const to = parseDate(req.query.to, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  if (from > to) return res.status(400).json({ error: 'Дата начала позже даты окончания' });

  const visible = visibleCompanies(req.user.id);
  let company = String(req.query.company || 'all');
  if (visible.length === 1) company = visible[0].id;
  if (company !== 'all' && !visible.some(c => c.id === company)) return res.status(403).json({ error: 'Нет доступа к этой компании' });
  const allowed = visible.map(c => c.id);
  const key = `${company}|${allowed.join(',')}|${from.toDateString()}|${to.toDateString()}`;
  const scope = userScope(req.user.id);
  const send = async (data, cached) => {
    const idx = await getBranchIndex().catch(() => null);
    res.json({ ...applyScope(data, scope, idx, String(req.query.branch || '')), cached });
  };
  const hit = cache.get(key);
  if (hit && req.query.refresh !== '1' && Date.now() - hit.at < config.cacheTtlMs) return send(hit.data, true);
  try {
    // Не дёргаем 1С параллельно одинаковыми запросами
    if (!inflight.has(key)) {
      inflight.set(key, buildReport({ from, to, company, allowed }).finally(() => inflight.delete(key)));
    }
    const data = await inflight.get(key);
    cache.set(key, { at: Date.now(), data });
    await send(data, false);
  } catch (err) {
    console.error('[report]', err.message, err.url || '');
    res.status(502).json({ error: err.message });
  }
});

// ---- Управление доступом (только админ приложения) ----
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Только для администратора приложения' });
  next();
}
app.get('/api/access', requireSession, requireAdmin, (req, res) => res.json(readAccess()));
app.put('/api/access', requireSession, requireAdmin, (req, res) => {
  const users = Array.isArray(req.body?.users) ? req.body.users : null;
  if (!users) return res.status(400).json({ error: 'Нужен список users' });
  const clean = [];
  const seen = new Set();
  for (const u of users) {
    const id = String(u?.id ?? '').trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const role = id === ROOT_ADMIN ? 'admin' : ROLES.includes(u.role) ? u.role : 'all';
    clean.push({ id, name: String(u.name || '').slice(0, 120), role, branches: role === 'director' && Array.isArray(u.branches) ? u.branches.map(String) : [] });
  }
  if (!seen.has(ROOT_ADMIN)) clean.unshift({ id: ROOT_ADMIN, name: 'Денис Гусельников', role: 'admin', branches: [] });
  const acc = readAccess();
  acc.users = clean;
  writeAccess(acc);
  console.log(`[access] ${req.user.id} обновил список: ${clean.map(u => u.id).join(',')}`);
  res.json(acc);
});

// Напоминания: ?dry=1 показывает, что будет создано; POST создаёт сейчас
app.get('/api/admin/reminders', requireSession, requireAdmin, async (req, res) => {
  try { res.json(await runReminders({ dry: true })); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/admin/reminders', requireSession, requireAdmin, async (req, res) => {
  try { res.json(await runReminders()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/branches', requireSession, requireAdmin, async (req, res) => {
  const idx = await getBranchIndex({ force: req.query.refresh === '1' }).catch(() => null);
  res.json({ branches: idx?.branches || [], builtAt: idx?.builtAt || null, stats: idx?.stats || null });
});

app.get('/health', (req, res) => res.json({ ok: true, mock: config.mock }));

getBranchIndex().catch(e => console.error('[branches]', e.message));
app.listen(config.port, () => {
  startReminders();
  console.log(`[arbitr-1c] порт ${config.port}, ${config.mock ? 'MOCK-данные' : '1С: ' + config.odataUrl}${config.devNoAuth ? ', БЕЗ авторизации' : ''}`);
});
