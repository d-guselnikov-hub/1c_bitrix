// Проверка подключения к 1С и подсказка правильных имён объектов.
// Запуск: npm run discover   (берёт настройки из .env)
import { config, companies } from '../src/config.js';
import { odataGet, odataMetadata } from '../src/odata.js';

if (config.mock) {
  console.error('Задай CO1_ODATA_URL/USER/PASSWORD (и CO2_...) в .env и MOCK=0');
  process.exit(1);
}
const only = process.argv[2];

const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = m => console.log('  \x1b[31m✗\x1b[0m ' + m);
const h = m => console.log('\n\x1b[1m' + m + '\x1b[0m');

for (const conn of companies.filter(c => !only || c.id === only)) {
  console.log('\n\x1b[1m===== ' + conn.name + ' =====\x1b[0m');
  await check(conn);
}
console.log('\nЕсли везде ✓, запускай npm start. Если нет, пришли этот вывод.');

async function check(conn) {
  h('1. Метаданные OData');
  let sets = [];
  try {
    const xml = await odataMetadata(conn);
    sets = [...xml.matchAll(/<EntitySet\s+Name="([^"]+)"/g)].map(m => m[1]);
    ok(`опубликовано объектов: ${sets.length}`);
    const pick = re => sets.filter(s => re.test(s));
    const show = (title, list) => console.log(`    ${title}: ${list.length ? list.slice(0, 15).join(', ') : '— нет —'}`);
    show('Регистры бухгалтерии', pick(/^AccountingRegister_[^_]+$/));
    show('Планы счетов', pick(/^ChartOfAccounts_/));
    show('Счета на оплату', pick(/^Document_.*Счет.*(Оплат|Покупател)/i));
    show('Поступления денег', pick(/^Document_.*(Поступлени|ПКО|Приходн|ПлатежноеПоручениеВходящее|Платежн)/i));
    show('Контрагенты', pick(/^Catalog_Контрагент/));
    show('Пользователи', pick(/^Catalog_Пользовател/));
    if (!sets.length) bad('Список пуст: в 1С не выбран состав стандартного интерфейса OData');
  } catch (e) {
    bad(e.message);
    return;
  }

  const need = [config.chartOfAccounts, config.regAccounting, `${config.regAccounting}_RecordType`, config.docInvoice, config.catClients, config.catUsers];
  h('2. Объекты из .env');
  for (const n of need) (sets.includes(n) ? ok : bad)(n);

  h('3. План счетов');
  try {
    const acc = await odataGet(conn, config.chartOfAccounts, { $select: 'Ref_Key,Code,Description' });
    for (const code of [...config.accReceivable, ...config.accAdvances]) {
      const a = acc.find(x => String(x.Code).trim() === code);
      a ? ok(`${code} ${a.Description}`) : bad(`${code} не найден`);
    }
  } catch (e) { bad(e.message); }

  h('4. Пример проводки регистра (поля)');
  try {
    const r = await odataGet(conn, `${config.regAccounting}_RecordType`, { $top: 1 });
    console.log('    ' + Object.keys(r[0] || {}).join(', '));
  } catch (e) { bad(e.message); }

  h('5. Пример счёта на оплату (поля)');
  try {
    const r = await odataGet(conn, config.docInvoice, { $top: 1, $orderby: 'Date desc' });
    console.log('    ' + Object.keys(r[0] || {}).filter(k => !k.includes('@')).join(', '));
  } catch (e) { bad(e.message); }


}
