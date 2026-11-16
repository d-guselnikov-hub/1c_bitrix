(() => {
  const BOOT = window.__BOOT__ || {};
  const $ = id => document.getElementById(id);
  const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90'];
  const BUCKET_LABEL = { current: 'В сроке', d1_30: '1–30 дн.', d31_60: '31–60 дн.', d61_90: '61–90 дн.', d90: 'Более 90 дн.' };

  const state = {
    company: 'all', branch: '', data: null, tab: 'clients', q: '', onlyDebt: false, open: null,
    sort: { clients: ['overdue', -1], invoices: ['date', -1], managers: ['invoicesSum', -1] },
  };

  // ---------- формат ----------
  const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const money = v => (v ? nf.format(Math.round(v)) : '0') + ' ₸';
  const short = v => {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн ₸';
    if (a >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' тыс ₸';
    return money(v);
  };
  const date = s => (s ? s.slice(0, 10).split('-').reverse().join('.') : '');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---------- период ----------
  function preset(p) {
    const n = new Date();
    const y = n.getFullYear(), m = n.getMonth();
    if (p === 'prev') return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    if (p === 'quarter') return [new Date(y, Math.floor(m / 3) * 3, 1), n];
    if (p === 'year') return [new Date(y, 0, 1), n];
    return [new Date(y, m, 1), n];
  }
  function setPreset(p) {
    const [f, t] = preset(p);
    $('from').value = ymd(f);
    $('to').value = ymd(t);
    document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  }

  // ---------- загрузка ----------
  async function load(refresh = false) {
    $('loader').hidden = false;
    $('err').hidden = true;
    try {
      const qs = new URLSearchParams({ from: $('from').value, to: $('to').value, company: state.company });
      if (state.branch) qs.set('branch', state.branch);
      if (refresh) qs.set('refresh', '1');
      const res = await fetch('/api/report?' + qs, { headers: { 'X-Session': BOOT.session || '' } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Ошибка ' + res.status);
      state.data = j;
      render();
    } catch (e) {
      $('err').textContent = e.message;
      $('err').hidden = false;
    } finally {
      $('loader').hidden = true;
      fit();
    }
  }

  // ---------- отрисовка ----------
  function render() {
    const d = state.data;
    const t = d.totals;
    $('src').textContent = d.source === 'mock' ? 'тестовые данные' : '1С Фреш';
    $('src').className = 'src' + (d.source === 'mock' ? ' mock' : '');
    $('term').textContent = `на ${date(d.period.to)}, срок оплаты ${d.settings.paymentTermDays} дн. от начисления`;

    const w = d.warnings || [];
    $('warn').hidden = !w.length;
    $('warn').innerHTML = w.map(esc).join('<br>');

    const overdueShare = t.debt ? Math.round((t.overdue / t.debt) * 100) : 0;
    $('kpis').innerHTML = [
      kpi('Выставлено счетов', short(t.invoicesSum), `${t.invoicesCount} шт. за период`),
      kpi('Начислено', short(t.accrued), 'акты/реализация за период'),
      kpi('Оплачено', short(t.paid), 'поступления за период', 'k-ok'),
      kpi('Дебиторка', short(t.debt), `${t.debtorsCount} должников`, 'k-warn'),
      kpi('Просрочено', short(t.overdue), `${overdueShare}% долга, ${t.overdueCount} клиентов`, t.overdue ? 'k-bad' : 'k-ok'),
      kpi('Авансы', short(t.advances), 'предоплата клиентов'),
    ].join('');

    const total = d.aging.reduce((s, a) => s + a.sum, 0);
    $('agingBar').innerHTML = total
      ? d.aging.filter(a => a.sum > 0).map(a => `<div class="c-${a.id}" style="flex:${a.sum}" title="${esc(a.label)}: ${money(a.sum)}"></div>`).join('')
      : '';
    $('agingLegend').innerHTML = d.aging.map(a =>
      `<span><i class="c-${a.id}"></i>${esc(a.label)}: <b>${money(a.sum)}</b></span>`).join('');

    $('foot').textContent = `Обновлено ${new Date(d.generatedAt).toLocaleString('ru-RU')}${d.cached ? ' (из кэша)' : ''}` +
      (BOOT.user ? ` · ${BOOT.user}` : '');
    renderBranchFilter();
    renderTable();
  }

  const ROLE_LABEL = { admin: 'Админ', all: 'Видит всё', director: 'Директор филиала', manager: 'Менеджер' };
  function renderBranchFilter() {
    const d = state.data;
    const sel = $('branchSel');
    const show = (d.role === 'admin' || d.role === 'all') && (d.branches || []).length > 0;
    sel.hidden = !show;
    if (show) {
      sel.innerHTML = '<option value="">Все филиалы</option>' + d.branches.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('') + '<option value="-">Без филиала</option>';
      sel.value = state.branch;
    }
    $('roleNote').textContent = d.role === 'director' ? `Филиалы: ${(d.branches || []).join(', ') || 'не назначены'}` : d.role === 'manager' ? 'Только ваши клиенты' : '';
  }

  const kpi = (l, v, s, cls = '') => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${esc(s)}</div></div>`;

  const COLS = {
    clients: [
      { k: 'name', t: 'Клиент', f: c => `${esc(c.name)}${bxLinks(c)}<div class="sub">${[state.company === 'all' ? c.company : '', c.bin, c.managers.join(', ')].filter(Boolean).map(esc).join(' · ')}</div>` },
      { k: 'branch', t: 'Филиал', f: c => c.branch ? esc(c.branch) : '<span class="muted">—</span>' },
      { k: 'invoicesSum', t: 'Счета за период', n: 1, f: c => c.invoicesCount ? `${money(c.invoicesSum)}<div class="sub">${c.invoicesCount} шт.</div>` : '<span class="muted">—</span>' },
      { k: 'paid', t: 'Оплачено', n: 1, f: c => c.paid ? `<span class="pos">${money(c.paid)}</span>` : '<span class="muted">—</span>' },
      { k: 'debt', t: 'Долг', n: 1, f: c => (c.debt > 0 ? money(c.debt) : '<span class="muted">—</span>') + miniBar(c) },
      { k: 'overdue', t: 'Просрочено', n: 1, f: c => c.overdue > 0 ? `<span class="neg">${money(c.overdue)}</span>` : '<span class="muted">—</span>' },
      { k: 'maxDaysOverdue', t: 'Дней', n: 1, f: c => daysPill(c.maxDaysOverdue, c.overdue) },
      { k: 'advance', t: 'Аванс', n: 1, f: c => c.advance > 0 ? money(c.advance) : '<span class="muted">—</span>' },
      { k: 'lastPayment', t: 'Посл. оплата', f: c => c.lastPayment ? date(c.lastPayment) : '<span class="muted">нет</span>' },
    ],
    invoices: [
      { k: 'date', t: 'Дата', f: i => date(i.date) },
      { k: 'number', t: 'Номер', f: i => esc(i.number.replace(/^0+/, '')) + bxLinks(i) + (i.posted ? '' : ' <span class="pill">не проведён</span>') },
      { k: 'client', t: 'Клиент', f: i => esc(i.client) + (state.company === 'all' ? `<div class="sub">${esc(i.company)}</div>` : '') },
      { k: 'branch', t: 'Филиал', f: i => i.branch ? esc(i.branch) : '<span class="muted">—</span>' },
      { k: 'manager', t: 'Ответственный', f: i => esc(i.manager) },
      { k: 'sum', t: 'Сумма', n: 1, f: i => money(i.sum) },
      { k: 'clientDebt', t: 'Долг клиента сейчас', n: 1, f: i => i.clientDebt > 0 ? (i.clientOverdue > 0 ? `<span class="neg">${money(i.clientDebt)}</span>` : money(i.clientDebt)) : '<span class="pill ok">нет долга</span>' },
    ],
    managers: [
      { k: 'name', t: 'Менеджер', f: m => esc(m.name) },
      { k: 'invoicesCount', t: 'Счетов', n: 1, f: m => m.invoicesCount },
      { k: 'invoicesSum', t: 'На сумму', n: 1, f: m => money(m.invoicesSum) },
      { k: 'clientsCount', t: 'Клиентов', n: 1, f: m => m.clientsCount },
      { k: 'debt', t: 'Долг его клиентов', n: 1, f: m => money(m.debt) },
      { k: 'overdue', t: 'Из них просрочено', n: 1, f: m => m.overdue > 0 ? `<span class="neg">${money(m.overdue)}</span>` : '—' },
    ],
  };

  // Ссылка на последнюю сделку клиента в Битриксе
  // Ссылки в Битрикс: сделка (в ней же вкладка «Счета») и карточка клиента
  const ENT = { contact: 'клиент', company: 'компания' };
  const bxLinks = x => {
    const a = (path, text, title) => ` <a href="#" class="deal-link" data-path="${esc(path)}" title="${title}">${text} ↗</a>`;
    let h = x.dealId ? a(`/crm/deal/details/${x.dealId}/`, 'сделка', 'Открыть сделку в Битриксе, счета клиента во вкладке «Счета»') : '';
    const [t, id] = String(x.bxEntity || '').split(':');
    if (ENT[t] && id && id !== '0') h += a(`/crm/${t}/details/${id}/`, ENT[t], 'Открыть карточку клиента в Битриксе');
    return h;
  };
  function openDeal(path) {
    if (window.BX24 && BX24.openPath) { try { BX24.openPath(path); return; } catch { /* ниже откроем вкладкой */ } }
    window.open('https://' + (BOOT.portal || 'myarbitr.bitrix24.kz') + path, '_blank', 'noopener');
  }

  function miniBar(c) {
    if (!(c.debt > 0)) return '';
    return `<div class="mini">${BUCKETS.filter(b => c.aging[b] > 0).map(b => `<div class="c-${b}" style="flex:${c.aging[b]}"></div>`).join('')}</div>`;
  }
  function daysPill(days, overdue) {
    if (!(overdue > 0)) return '<span class="muted">—</span>';
    const cls = days > 60 ? 'bad' : days > 30 ? 'warn' : '';
    return `<span class="pill ${cls}">${days}</span>`;
  }

  function rows() {
    const d = state.data;
    const q = state.q.trim().toLowerCase();
    let list;
    if (state.tab === 'clients') {
      list = d.clients.filter(c => (!state.onlyDebt || c.debt > 0) &&
        (!q || c.name.toLowerCase().includes(q) || c.bin.includes(q)));
    } else if (state.tab === 'invoices') {
      const byId = new Map(d.clients.map(c => [c.id, c]));
      list = d.invoices.map(i => ({ ...i, clientDebt: byId.get(i.clientId)?.debt || 0, clientOverdue: byId.get(i.clientId)?.overdue || 0 }))
        .filter(i => (!state.onlyDebt || i.clientDebt > 0) &&
          (!q || i.client.toLowerCase().includes(q) || i.number.toLowerCase().includes(q) || i.manager.toLowerCase().includes(q)));
    } else {
      list = d.managers.filter(m => !q || m.name.toLowerCase().includes(q));
    }
    const [k, dir] = state.sort[state.tab];
    return list.slice().sort((a, b) => {
      const x = a[k] ?? '', y = b[k] ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru')) * dir;
    });
  }

  function renderTable() {
    const cols = COLS[state.tab];
    const [sk, sd] = state.sort[state.tab];
    const list = rows();
    $('onlyDebtWrap').style.visibility = state.tab === 'managers' ? 'hidden' : '';
    const head = `<thead><tr>${cols.map(c =>
      `<th class="${c.n ? 'n' : ''}" data-k="${c.k}">${c.t}${c.k === sk ? ` <span class="arr">${sd > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>`;
    let body = '';
    for (const r of list) {
      const clickable = state.tab === 'clients' || state.tab === 'invoices';
      const id = state.tab === 'invoices' ? r.clientId : r.id;
      body += `<tr class="row${clickable ? ' click' : ''}" data-id="${esc(id || '')}">${cols.map(c => `<td class="${c.n ? 'n' : ''}">${c.f(r)}</td>`).join('')}</tr>`;
      if (state.tab === 'clients' && state.open === r.id) body += `<tr class="detail"><td colspan="${cols.length}">${detail(r)}</td></tr>`;
    }
    if (!list.length) body = `<tr><td colspan="${cols.length}" class="empty">Ничего не найдено</td></tr>`;
    if (state.tab === 'clients' && list.length) {
      const s = k => list.reduce((a, c) => a + (c[k] || 0), 0);
      body += `<tr><td><b>Итого (${list.length})</b></td><td></td><td class="n"><b>${money(s('invoicesSum'))}</b></td><td class="n"><b>${money(s('paid'))}</b></td>
        <td class="n"><b>${money(s('debt'))}</b></td><td class="n"><b class="neg">${money(s('overdue'))}</b></td><td></td><td class="n"><b>${money(s('advance'))}</b></td><td></td></tr>`;
    }
    $('tbl').innerHTML = head + `<tbody>${body}</tbody>`;
    fit();
  }

  function detail(c) {
    const inv = state.data.invoices.filter(i => i.clientId === c.id);
    const aging = BUCKETS.map(b => `<tr><td><i class="c-${b}" style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px"></i>${BUCKET_LABEL[b]}</td><td class="n">${money(c.aging[b])}</td></tr>`).join('');
    const invRows = inv.length
      ? inv.map(i => `<tr><td>${date(i.date)}</td><td>${esc(i.number)}</td><td>${esc(i.manager)}</td><td class="n">${money(i.sum)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">Счетов за период нет</td></tr>';
    return `<div class="detail-grid">
      <div><b>Возраст долга</b><table>${aging}</table>
        <div class="sub" style="margin-top:6px">Начислено за период: ${money(c.accrued)}</div></div>
      <div><b>Счета за период</b><table><thead><tr><th>Дата</th><th>Номер</th><th>Ответственный</th><th class="n">Сумма</th></tr></thead>${invRows}</table></div>
    </div>`;
  }

  // ---------- CSV ----------
  function csv() {
    const cols = COLS[state.tab];
    const plain = {
      clients: [['Компания', 'company'], ['Клиент', 'name'], ['БИН/ИИН', 'bin'], ['Счетов', 'invoicesCount'], ['Сумма счетов', 'invoicesSum'], ['Начислено', 'accrued'],
        ['Оплачено', 'paid'], ['Долг', 'debt'], ['Просрочено', 'overdue'], ['Макс. дней просрочки', 'maxDaysOverdue'], ['Аванс', 'advance'],
        ...BUCKETS.map(b => [BUCKET_LABEL[b], r => r.aging[b]]), ['Последняя оплата', r => date(r.lastPayment)], ['Менеджеры', r => r.managers.join(', ')]],
      invoices: [['Компания', 'company'], ['Дата', r => date(r.date)], ['Номер', 'number'], ['Клиент', 'client'], ['Ответственный', 'manager'], ['Сумма', 'sum'], ['Долг клиента', 'clientDebt']],
      managers: cols.map(c => [c.t, c.k]),
    }[state.tab];
    const cell = v => {
      const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [plain.map(p => p[0]).join(';')];
    for (const r of rows()) lines.push(plain.map(([, k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(';'));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `1c_${state.company}_${state.tab}_${$('from').value}_${$('to').value}.csv`;
    a.click();
  }

  // ---------- Битрикс: подгоняем высоту фрейма ----------
  function fit() {
    if (window.BX24 && BX24.fitWindow) try { BX24.fitWindow(); } catch { /* вне Битрикса */ }
  }

  // ---------- компании ----------
  const COMPANIES = BOOT.companies || [];
  if (COMPANIES.length > 1) {
    const opts = [...COMPANIES.map(c => ({ id: c.id, name: c.name })), { id: 'all', name: 'Обе' }];
    $('companies').innerHTML = opts.map(o => `<button data-c="${esc(o.id)}" class="${o.id === state.company ? 'on' : ''}">${esc(o.name)}</button>`).join('');
    $('companies').addEventListener('click', e => {
      const c = e.target.dataset.c;
      if (!c || c === state.company) return;
      state.company = c;
      state.open = null;
      document.querySelectorAll('#companies button').forEach(b => b.classList.toggle('on', b.dataset.c === c));
      load();
    });
  } else {
    $('companies').hidden = true;
    state.company = COMPANIES[0]?.id || 'all';
  }

  // ---------- события ----------
  $('presets').addEventListener('click', e => {
    const p = e.target.dataset.p;
    if (!p) return;
    setPreset(p);
    load();
  });
  ['from', 'to'].forEach(id => $(id).addEventListener('change', () => {
    document.querySelectorAll('#presets button').forEach(b => b.classList.remove('on'));
    load();
  }));
  $('refresh').addEventListener('click', () => load(true));
  $('branchSel').addEventListener('change', e => { state.branch = e.target.value; state.open = null; load(); });
  $('tabs').addEventListener('click', e => {
    const t = e.target.dataset.t;
    if (!t) return;
    state.tab = t;
    document.querySelectorAll('#tabs button[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    if (state.data) renderTable();
  });
  $('q').addEventListener('input', e => { state.q = e.target.value; if (state.data) renderTable(); });
  $('onlyDebt').addEventListener('change', e => { state.onlyDebt = e.target.checked; if (state.data) renderTable(); });
  $('csv').addEventListener('click', () => state.data && csv());
  $('tbl').addEventListener('click', e => {
    const dl = e.target.closest('a.deal-link');
    if (dl) { e.preventDefault(); e.stopPropagation(); return openDeal(dl.dataset.path); }
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      const [ck, cd] = state.sort[state.tab];
      state.sort[state.tab] = [k, ck === k ? -cd : (typeof (state.data?.[state.tab]?.[0]?.[k]) === 'number' ? -1 : 1)];
      return renderTable();
    }
    const tr = e.target.closest('tr.row.click');
    if (!tr || !tr.dataset.id) return;
    if (state.tab === 'invoices') {
      // Из счёта переходим к карточке клиента
      state.tab = 'clients';
      document.querySelectorAll('#tabs button[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === 'clients'));
      state.open = tr.dataset.id;
      state.q = '';
      $('q').value = '';
    } else {
      state.open = state.open === tr.dataset.id ? null : tr.dataset.id;
    }
    renderTable();
  });

  // ---------- доступ ----------
  let access = null;
  async function accessApi(method, body, url = '/api/access') {
    const res = await fetch(url, {
      method, headers: { 'X-Session': BOOT.session || '', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Ошибка ' + res.status);
    return j;
  }
  let branchNames = [];
  function renderAccess() {
    $('accessTbl').innerHTML = '<tr class="muted"><td>Сотрудник</td><td>ID</td><td>Роль</td><td>Филиалы директора</td><td></td></tr>' + access.users.map(u => {
      const adm = u.id === '30833';
      const role = adm ? '<span class="pill">админ</span>' : `<select data-role="${esc(u.id)}">${['admin', 'all', 'director', 'manager'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
      const br = !adm && u.role === 'director'
        ? `<select multiple size="4" data-br="${esc(u.id)}">${branchNames.map(b => `<option${u.branches.includes(b) ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>`
        : '<span class="muted">—</span>';
      return `<tr><td>${esc(u.name || 'без имени')}</td><td class="muted">ID ${esc(u.id)}</td><td>${role}</td><td>${br}</td>
        <td>${adm ? '' : `<button data-del="${esc(u.id)}">Убрать</button>`}</td></tr>`;
    }).join('');
    fit();
  }
  async function saveAccess(users) {
    $('accessMsg').textContent = 'Сохраняю…';
    try {
      access = await accessApi('PUT', { users });
      $('accessMsg').textContent = 'Сохранено';
      renderAccess();
    } catch (e) { $('accessMsg').textContent = e.message; }
  }
  if (BOOT.admin) {
    $('accessBtn').hidden = false;
    $('accessBtn').addEventListener('click', async () => {
      const card = $('accessCard');
      card.hidden = !card.hidden;
      $('accessBtn').classList.toggle('on', !card.hidden);
      if (!card.hidden) {
        try { access = await accessApi('GET'); try { branchNames = (await accessApi('GET', null, '/api/branches')).branches; } catch { /* без Битрикса */ } renderAccess(); } catch (e) { $('accessMsg').textContent = e.message; }
      }
      fit();
    });
    const inBitrix = !!(window.BX24 && BX24.selectUsers);
    $('accessManual').hidden = inBitrix;
    $('accessPick').hidden = !inBitrix;
    $('accessPick').addEventListener('click', () => {
      // Стандартный выбор сотрудников Битрикса
      BX24.selectUsers(list => {
        if (!list || !list.length) return;
        const add = list.map(u => ({ id: String(u.id), name: u.name }));
        saveAccess([...access.users, ...add.filter(a => !access.users.some(u => u.id === a.id)).map(a => ({ ...a, role: 'manager', branches: [] }))]);
      });
    });
    $('accAdd').addEventListener('click', () => {
      const id = $('accId').value.trim();
      if (!/^\d+$/.test(id)) { $('accessMsg').textContent = 'ID должен быть числом'; return; }
      if (access.users.some(u => u.id === id)) return;
      saveAccess([...access.users, { id, name: $('accName').value.trim(), role: 'manager', branches: [] }]);
      $('accId').value = ''; $('accName').value = '';
    });
    $('accessTbl').addEventListener('change', e => {
      const t = e.target;
      const u = access.users.find(x => x.id === (t.dataset.role || t.dataset.br));
      if (!u) return;
      if (t.dataset.role) { u.role = t.value; if (u.role !== 'director') u.branches = []; }
      if (t.dataset.br) u.branches = [...t.selectedOptions].map(o => o.value);
      saveAccess(access.users);
    });
    $('accessTbl').addEventListener('click', e => {
      const id = e.target.dataset.del;
      if (id) saveAccess(access.users.filter(u => u.id !== id));
    });
  }

  if (window.BX24) try { BX24.init(fit); } catch { /* вне Битрикса */ }
  setPreset('month');
  load();
})();

// Админ: подключить вкладку «Выставить счёт» в карточках сделок (нужны права crm и placement у приложения)
(function () {
  const BOOT = window.__BOOT__ || {};
  if (!BOOT.admin || !window.BX24) return;
  const b = document.createElement('button'); b.textContent = 'Вкладка «Счёт» в сделках'; b.title = 'Подключить вкладку выставления счёта';
  b.onclick = () => BX24.callMethod('placement.bind', { PLACEMENT: 'CRM_DEAL_DETAIL_TAB', HANDLER: location.origin + '/placement/deal', TITLE: 'Выставить счёт', DESCRIPTION: 'Счёт в 1С и Битрикс' }, r => {
    b.textContent = r.error() ? 'Ошибка: ' + (r.error_description ? r.error_description() : r.error()) : 'Вкладка подключена ✓';
  });
  const host = document.getElementById('accessBtn'); host?.parentNode.insertBefore(b, host.nextSibling);
})();
