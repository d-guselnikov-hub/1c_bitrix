// Напоминания менеджерам по счетам рассрочки.
// Раз в день находит неоплаченные смарт-счета Битрикса, у которых скоро срок или он уже прошёл,
// и ставит ответственному по сделке дело в карточке сделки. Каждое напоминание ставится один раз.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { bx, bxAll, bitrixEnabled } from './bitrixApi.js';

const file = path.join(config.root, 'data', 'reminders.json');
const TZ = process.env.TZ_LOCAL || 'Asia/Almaty';
const DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE || 3);
const HOUR = Number(process.env.REMINDER_HOUR || 9);
const OVERDUE_WINDOW = 7; // старые просрочки не поднимаем, только за последнюю неделю
const MAX_PER_RUN = 400;
const UNPAID = ['DT31_3:N', 'DT31_3:S', 'DT31_3:D'];

const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const localHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(d));
const shift = (iso, days) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const ru = iso => iso.split('-').reverse().join('.');
const money = n => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₸';

function readState() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { sent: {}, lastRun: '' }; } }
function writeState(s) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s)); }

// Что нужно напомнить сегодня. dry=true ничего не пишет
export async function runReminders({ dry = false } = {}) {
  const today = localDate();
  const state = readState();
  const invs = await bxAll('crm.item.list', {
    entityTypeId: 31,
    filter: { '@stageId': UNPAID, '>=closedate': shift(today, -OVERDUE_WINDOW), '<=closedate': shift(today, DAYS_BEFORE) },
    select: ['id', 'title', 'opportunity', 'closedate', 'stageId', 'parentId2'],
  }, j => j.result?.items);

  const dealIds = [...new Set(invs.map(i => i.parentId2).filter(Boolean))];
  const deals = new Map();
  for (let i = 0; i < dealIds.length; i += 50) {
    const part = await bxAll('crm.deal.list', { filter: { '@ID': dealIds.slice(i, i + 50) }, select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'STAGE_SEMANTIC_ID'] });
    for (const d of part) deals.set(String(d.ID), d);
  }

  const todo = [];
  for (const inv of invs) {
    const deal = deals.get(String(inv.parentId2));
    if (!deal || deal.STAGE_SEMANTIC_ID === 'F') continue; // нет сделки или сделка провалена
    const due = String(inv.closedate || '').slice(0, 10);
    const kind = due < today ? 'overdue' : 'soon';
    if ((state.sent[inv.id] || []).includes(kind)) continue;
    const sum = money(Number(inv.opportunity) || 0);
    todo.push({
      invoiceId: inv.id, dealId: deal.ID, responsibleId: deal.ASSIGNED_BY_ID, kind, due,
      title: kind === 'soon' ? `Отправить счёт и получить оплату: ${sum} до ${ru(due)}` : `Просрочен платёж ${sum} (срок был ${ru(due)})`,
      description: kind === 'soon'
        ? `${inv.title}. Срок оплаты ${ru(due)}. Отправьте счёт клиенту и проконтролируйте оплату. Когда деньги придут, переведите счёт в «Оплачен».`
        : `${inv.title}. Срок оплаты прошёл ${ru(due)}, оплаты нет. Свяжитесь с клиентом и договоритесь о дате. Если клиент оплатил, переведите счёт в «Оплачен».`,
      deadline: `${kind === 'soon' ? due : today}T18:00:00`,
    });
  }
  if (dry) return { today, found: invs.length, toCreate: todo.length, sample: todo.slice(0, 20) };

  let created = 0, failed = 0;
  for (const t of todo.slice(0, MAX_PER_RUN)) {
    try {
      await bx('crm.activity.todo.add', { ownerTypeId: 2, ownerId: Number(t.dealId), deadline: t.deadline, title: t.title, description: t.description, responsibleId: Number(t.responsibleId) });
      (state.sent[t.invoiceId] ||= []).push(t.kind);
      created++;
    } catch (e) { failed++; console.error(`[reminders] счёт ${t.invoiceId}: ${e.message}`); }
  }
  // Оплаченные и давно прошедшие счета из памяти не убираем: список маленький, а повтор хуже
  state.lastRun = today;
  writeState(state);
  console.log(`[reminders] ${today}: найдено ${invs.length}, создано дел ${created}, ошибок ${failed}`);
  return { today, found: invs.length, created, failed, left: Math.max(0, todo.length - MAX_PER_RUN) };
}

let running = false;
export function startReminders() {
  if (process.env.REMINDERS !== '1' || !bitrixEnabled()) return;
  const tick = async () => {
    if (running) return;
    const st = readState();
    if (st.lastRun === localDate() || localHour() < HOUR) return;
    running = true;
    try { await runReminders(); } catch (e) { console.error('[reminders]', e.message); } finally { running = false; }
  };
  setInterval(tick, 10 * 60 * 1000);
  setTimeout(tick, 60 * 1000);
  console.log(`[reminders] включены: каждый день после ${HOUR}:00 (${TZ}), за ${DAYS_BEFORE} дн. до срока и при просрочке`);
}
