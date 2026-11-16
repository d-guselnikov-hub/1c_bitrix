// Проверка, что приложение открыл живой пользователь нашего портала
import crypto from 'node:crypto';
import { config } from './config.js';
import { isAllowed } from './access.js';

const SESSION_TTL = 12 * 3600 * 1000;

async function callRest(domain, method, auth) {
  const url = `https://${domain}/rest/${method}.json?auth=${encodeURIComponent(auth)}`;
  const res = await fetch(url, { method: 'POST' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error_description || j.error || `HTTP ${res.status}`);
  return j.result;
}

// Битрикс открывает обработчик POST-запросом с AUTH_ID; DOMAIN приходит в query
export async function verifyBitrixLaunch(req) {
  const domain = String(req.query.DOMAIN || req.body?.DOMAIN || '').toLowerCase();
  const auth = String(req.body?.AUTH_ID || req.query.AUTH_ID || '');
  if (!domain || !auth) throw new Error('Приложение нужно открывать из Битрикс24');
  if (domain !== config.bitrixDomain) throw new Error(`Портал ${domain} не разрешён`);

  // Токен проверяем запросом к самому порталу: подделать ответ нельзя
  const user = await callRest(domain, 'user.current', auth);
  const uid = String(user.ID);
  if (!isAllowed(uid)) {
    throw new Error('Нет доступа к отчёту. Обратись к Денису Гусельникову');
  }
  return { id: uid, name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' ') || user.EMAIL || `ID ${uid}` };
}

export function signSession(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const good = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
