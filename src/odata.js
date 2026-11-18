// Клиент стандартного интерфейса OData 1С (чтение и создание документов/элементов справочников)

const PAGE = 5000;

function authHeader(conn) {
  const token = Buffer.from(`${conn.user}:${conn.password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

// Кодируем имя сущности, но оставляем скобки/кавычки функций (Balance(...)) как есть
function entityPath(name) {
  return name.split('/').map(seg => {
    const i = seg.indexOf('(');
    if (i === -1) return encodeURIComponent(seg);
    return encodeURIComponent(seg.slice(0, i)) + encodeURI(seg.slice(i)).replace(/'/g, '%27');
  }).join('/');
}

function buildUrl(conn, entity, params = {}) {
  const qs = Object.entries({ $format: 'json', ...params })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${conn.url}/${entityPath(entity)}?${qs}`;
}

export class ODataError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

export async function odataGet(conn, entity, params = {}, { timeoutMs = 60000 } = {}) {
  if (!conn?.url) throw new ODataError(`База 1С «${conn?.name || '?'}» не подключена (нет ODATA_URL)`, 0, '');
  const url = buildUrl(conn, entity, params);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader(conn), Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new ODataError(`Нет связи с 1С: ${err.message}`, 0, url);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      msg = j['odata.error']?.message?.value || msg;
    } catch { /* не JSON */ }
    if (res.status === 401) msg = 'Неверный логин/пароль OData (401)';
    if (res.status === 404) msg = `Объект не найден или не опубликован в OData: ${entity} (${msg})`;
    throw new ODataError(msg, res.status, url);
  }
  try {
    const j = JSON.parse(text);
    return j.value ?? j;
  } catch {
    throw new ODataError('1С вернула не JSON', res.status, url);
  }
}

// Выкачивает всё постранично
export async function odataGetAll(conn, entity, params = {}) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const chunk = await odataGet(conn, entity, { ...params, $top: PAGE, $skip: skip });
    const arr = Array.isArray(chunk) ? chunk : [];
    out.push(...arr);
    if (arr.length < PAGE) break;
  }
  return out;
}

export async function odataMetadata(conn) {
  const url = `${conn.url}/$metadata`;
  const res = await fetch(url, { headers: { Authorization: authHeader(conn) } });
  if (!res.ok) throw new ODataError(`$metadata: HTTP ${res.status}`, res.status, url);
  return res.text();
}

// Формат дат для фильтров 1С
export const dt = d => `datetime'${toLocalIso(d)}'`;

export function toLocalIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Создание объекта (POST). Возвращает созданную запись.
export async function odataPost(conn, entity, body, { timeoutMs = 60000 } = {}) {
  if (!conn?.url) throw new ODataError(`База 1С «${conn?.name || '?'}» не подключена`, 0, '');
  const url = buildUrl(conn, entity, {});
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader(conn), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (err) {
    throw new ODataError(`Нет связи с 1С: ${err.message}`, 0, url);
  } finally { clearTimeout(t); }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 600);
    try { msg = JSON.parse(text)['odata.error']?.message?.value || msg; } catch { /* не JSON */ }
    throw new ODataError(`1С отклонила создание (${entity}): ${msg}`, res.status, url);
  }
  return JSON.parse(text);
}

// Изменение реквизитов объекта: PATCH Entity(guid'...')
export async function odataPatch(conn, entity, ref, body, { timeoutMs = 60000 } = {}) {
  if (!conn?.url) throw new ODataError(`База 1С «${conn?.name || '?'}» не подключена`, 0, '');
  const url = buildUrl(conn, `${entity}(guid'${ref}')`, {});
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: authHeader(conn), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (err) {
    throw new ODataError(`Нет связи с 1С: ${err.message}`, 0, url);
  } finally { clearTimeout(t); }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 600);
    try { msg = JSON.parse(text)['odata.error']?.message?.value || msg; } catch { /* не JSON */ }
    throw new ODataError(`1С отклонила изменение (${entity}): ${msg}`, res.status, url);
  }
  return text ? JSON.parse(text) : {};
}
