// Серверные вызовы REST Битрикс24 через входящий вебхук (BITRIX_WEBHOOK в .env).
const hook = () => (process.env.BITRIX_WEBHOOK || '').replace(/\/?$/, '/');
export const bitrixEnabled = () => !!process.env.BITRIX_WEBHOOK;

export async function bx(method, params = {}) {
  const res = await fetch(hook() + method + '.json', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error(`Битрикс ${method}: ${j.error_description || j.error}`);
  return j;
}

// Все записи списочного метода: пачками по 50 запросов (по 50 записей) в одном HTTP-вызове
export async function bxAll(method, params = {}, pick = j => j.result) {
  const first = await bx(method, { ...params, start: 0 });
  const out = [...(pick(first) || [])];
  const total = first.total || out.length;
  const starts = [];
  for (let s = 50; s < total; s += 50) starts.push(s);
  for (let i = 0; i < starts.length; i += 50) {
    const chunk = starts.slice(i, i + 50);
    const cmd = Object.fromEntries(chunk.map(s => [`s${s}`, `${method}?${new URLSearchParams(flat({ ...params, start: s })).toString()}`]));
    const r = await bx('batch', { halt: 0, cmd });
    for (const s of chunk) {
      const part = r.result?.result?.[`s${s}`];
      if (part) out.push(...(Array.isArray(part) ? part : pick({ result: part }) || []));
    }
  }
  return out;
}

// Вложенные параметры в виде a[b][c]=v, как ждёт batch
function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else out[key] = v;
  }
  return out;
}
