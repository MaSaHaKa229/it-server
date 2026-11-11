// Заявки: отчёты (все сотрудники helpdesk) и правила автоназначения (администратор helpdesk)
import { h, clear, modal, run, toast, confirmDialog } from '/shared/ui.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (s) => s.split('-').reverse().join('.');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const hours = (v) => (v == null ? '—' : v < 48 ? `${v} ч` : `${(v / 24).toFixed(1)} дн.`);

const STYLE = `
.rp-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin: 12px 0 20px; }
.rp-tile { border: 1px solid var(--border); border-radius: 3px; padding: 12px 14px; background: var(--n0); }
.rp-tile .v { font-size: 26px; font-weight: 600; line-height: 34px; }
.rp-tile .l { color: var(--text-subtle); font-size: 13px; }
.rp-tile.red .v { color: var(--r400); }
.rp-chart { display: flex; align-items: flex-end; gap: 2px; height: 140px; padding: 8px 0 0; border-bottom: 1px solid var(--border); }
.rp-chart .d { flex: 1; display: flex; align-items: flex-end; gap: 1px; height: 100%; min-width: 4px; }
.rp-chart .d i { display: block; flex: 1; min-height: 1px; border-radius: 2px 2px 0 0; }
.rp-chart .d i.c { background: #4C9AFF; }
.rp-chart .d i.x { background: #36B37E; }
.rp-axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-subtle); margin-top: 2px; }
.rp-legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-subtle); margin-top: 6px; }
.rp-legend b { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.rp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.rp-bar { height: 6px; background: var(--n30); border-radius: 3px; overflow: hidden; min-width: 60px; }
.rp-bar i { display: block; height: 100%; background: #4C9AFF; }
.rp-sec { margin: 24px 0 8px; }
`;
function style() {
  if (document.getElementById('rp-style')) return;
  const s = h('style', { id: 'rp-style' }); s.textContent = STYLE; document.head.append(s);
}

// ====================== Отчёты ======================
const range = { from: '', to: '' };

export async function renderReports({ layout, api }) {
  style();
  const now = new Date();
  if (!range.from) { range.from = iso(new Date(now.getFullYear(), now.getMonth(), 1)); range.to = iso(now); }
  const from = h('input', { type: 'date', value: range.from });
  const to = h('input', { type: 'date', value: range.to });
  const body = h('div', h('p.muted', 'Загрузка…'));
  const presets = [
    ['Этот месяц', () => [new Date(now.getFullYear(), now.getMonth(), 1), now]],
    ['Прошлый месяц', () => [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)]],
    ['Квартал', () => [new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), now]],
    ['Этот год', () => [new Date(now.getFullYear(), 0, 1), now]],
    ['30 дней', () => [new Date(now.getTime() - 29 * 864e5), now]],
  ];
  const excel = h('a.btn', { href: '#', title: 'Выгрузить отчёт в Excel' }, 'Excel');
  const load = async () => {
    range.from = from.value; range.to = to.value;
    excel.href = `/helpdesk/api/reports/export.xlsx?from=${range.from}&to=${range.to}`;
    try {
      const d = await api.get(`/reports?from=${range.from}&to=${range.to}`);
      draw(body, d);
    } catch (e) { clear(body, h('div.error-box', e.message)); }
  };
  from.addEventListener('change', load); to.addEventListener('change', load);
  layout('reports', [
    h('div.page-head', h('div', h('h1', 'Отчёты по заявкам'), h('div.muted', 'Поступило — по дате создания, закрыто — по дате закрытия')),
      h('span.spacer'), excel),
    h('div.toolbar', { style: { flexWrap: 'wrap', gap: '8px' } },
      h('span.muted', 'Период:'), from, h('span.muted', '—'), to,
      presets.map(([l, f]) => h('button.btn.sm', { onclick: () => { const [a, b] = f(); from.value = iso(a); to.value = iso(b); load(); } }, l))),
    body,
  ]);
  await load();
}

function table(rows, label) {
  const max = Math.max(1, ...rows.map((r) => r.created));
  return h('div.table-wrap', h('table.list',
    h('thead', h('tr', h('th', label), h('th', 'Поступило'), h('th', ''), h('th', 'Закрыто'), h('th', 'Открыто'),
      h('th', 'Просрочено'), h('th', 'Среднее время'), h('th', 'В срок'))),
    h('tbody', rows.length ? rows.map((r) => h('tr',
      h('td', r.name),
      h('td', h('b', r.created)),
      h('td', h('div.rp-bar', h('i', { style: { width: `${(r.created / max) * 100}%` } }))),
      h('td', r.closed),
      h('td', r.open_now),
      h('td', r.overdue_now ? h('span', { style: { color: 'var(--r400)', fontWeight: 600 } }, r.overdue_now) : '0'),
      h('td', hours(r.avg_hours)),
      h('td', r.with_due ? `${pct(r.on_time, r.with_due)} (${r.on_time}/${r.with_due})` : '—'))) : h('tr.empty', h('td', { colspan: 8 }, 'Нет данных')))));
}

function draw(box, d) {
  const t = d.total;
  const tile = (v, l, red) => h('div.rp-tile' + (red ? '.red' : ''), h('div.v', String(v)), h('div.l', l));
  const max = Math.max(1, ...d.by_day.map((x) => Math.max(x.created, x.closed)));
  const chart = h('div.rp-chart', d.by_day.map((x) => h('div.d', { title: `${fmtDay(x.day)}: поступило ${x.created}, закрыто ${x.closed}` },
    h('i.c', { style: { height: `${(x.created / max) * 100}%` } }), h('i.x', { style: { height: `${(x.closed / max) * 100}%` } }))));
  clear(box,
    h('div.rp-tiles',
      tile(t.created, 'поступило заявок'),
      tile(t.closed, 'закрыто'),
      tile(t.open_now, 'открыто сейчас'),
      tile(t.overdue_now, 'просрочено сейчас', t.overdue_now > 0),
      tile(hours(t.avg_hours), 'среднее время решения'),
      tile(hours(t.median_hours), 'медиана (типичная заявка)'),
      tile(t.with_due ? pct(t.on_time, t.with_due) : '—', `закрыто в срок (${t.on_time} из ${t.with_due} со сроком)`)),
    h('h3.rp-sec', 'Поступило и закрыто по дням'),
    chart,
    h('div.rp-axis', h('span', fmtDay(d.from)), h('span', fmtDay(d.to))),
    h('div.rp-legend', h('span', h('b', { style: { background: '#4C9AFF' } }), 'поступило'), h('span', h('b', { style: { background: '#36B37E' } }), 'закрыто')),
    h('h3.rp-sec', 'По исполнителям'), table(d.by_executor, 'Исполнитель'),
    h('h3.rp-sec', 'По видам проблем — частые проблемы'), table(d.by_category, 'Вид проблемы'),
    h('h3.rp-sec', 'По отделам'), table(d.by_department, 'Отдел'),
    h('div.rp-grid',
      h('div', h('h3.rp-sec', 'Поступившие по статусу'), h('table.list', h('tbody', d.by_status.length ? d.by_status.map((s) => h('tr',
        h('td', h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: s.color, marginRight: '6px' } }), s.name),
        h('td', h('b', s.n)))) : h('tr.empty', h('td', 'Нет данных'))))),
      h('div', h('h3.rp-sec', 'Поступившие по приоритету'), h('table.list', h('tbody', d.by_priority.length ? d.by_priority.map((s) => h('tr',
        h('td', s.name), h('td', h('b', s.n)))) : h('tr.empty', h('td', 'Нет данных')))))),
    h('p.hint', { style: { marginTop: '16px' } }, 'Открыто и просрочено — на текущий момент. Время решения — от создания до закрытия заявки, по закрытым в периоде. ',
      '«В срок» — доля закрытых до срока среди заявок, у которых срок был задан. В Excel — те же таблицы и список заявок.'));
}

// ====================== Автоназначение ======================
export async function renderRules({ layout, api, meta }) {
  const d = await api.get('/rules');
  const reload = () => renderRules({ layout, api, meta });
  const execName = (id) => (meta.executors.find((x) => x.id === id) || {}).name || `#${id}`;
  const rows = d.rules.map((r, i) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) ruleDialog(r); } },
    h('td.muted', String(i + 1)),
    h('td', r.category_name || h('span.muted', 'любой')),
    h('td', r.department_name || h('span.muted', 'любой')),
    h('td', r.mode === 'user' ? h('b', r.assignee_name || '—')
      : ['наименее загруженный', h('div.small.muted', r.pool.length ? 'из: ' + r.pool.map(execName).join(', ') : 'из всех исполнителей')]),
    h('td', r.is_active ? 'включено' : h('span.lozenge', 'выключено')),
    h('td', { style: { textAlign: 'right' } }, h('button.btn.subtle.sm', {
      onclick: async () => {
        if (!await confirmDialog('Удалить правило?', 'Новые заявки перестанут назначаться по этому правилу.')) return;
        run(async () => { await api.del('/rules/' + r.id); toast('Удалено'); reload(); });
      },
    }, '🗑'))));

  // Проверка «кому уйдёт заявка»
  const tCat = h('select', h('option', { value: '' }, 'любой вид'), meta.categories.map((c) => h('option', { value: c.id }, c.name)));
  const tDep = h('select', h('option', { value: '' }, 'отдел не указан'), d.departments.map((x) => h('option', { value: x.id }, x.value)));
  const tRes = h('span');
  const test = () => run(async () => {
    const r = await api.post('/rules/test', { category_id: tCat.value || null, department_id: tDep.value || null });
    clear(tRes, r.assigneeId ? ['→ ', h('b', r.name), h('span.muted', ` (${r.how})`)] : h('span.muted', '→ без исполнителя (назначит администратор)'));
  });

  layout('rules', [
    h('div.page-head', h('div', h('h1', 'Автоназначение исполнителя'),
      h('div.muted', 'Кому сразу попадает новая заявка — по виду проблемы и отделу сотрудника')),
    h('span.spacer'), h('button.btn.primary', { onclick: () => ruleDialog(null) }, '+ Добавить правило')),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', '№'), h('th', 'Вид проблемы'), h('th', 'Отдел заявителя'), h('th', 'Кому'), h('th', ''), h('th', ''))),
      h('tbody', rows.length ? rows : h('tr.empty', h('td', { colspan: 6 }, 'Правил нет — заявка уходит исполнителю вида проблемы (если он задан)'))))),
    h('p.hint', 'Правила проверяются сверху вниз, срабатывает первое подходящее. Если нужный исполнитель сегодня в отпуске, на больничном и т. п. ',
      '(отмечено в календаре) — правило пропускается. Если ни одно правило не подошло — заявка уходит исполнителю по умолчанию из «Видов проблем». ',
      'Срок выполнения не ставится — его задаёт администратор.'),
    h('div.toolbar', { style: { marginTop: '16px', gap: '8px', flexWrap: 'wrap' } }, h('strong', 'Проверить:'), tCat, tDep,
      h('button.btn', { onclick: test }, 'Кому уйдёт заявка?'), tRes),
  ]);

  function ruleDialog(r) {
    const cat = h('select', h('option', { value: '' }, '— любой —'), meta.categories.map((c) => h('option', { value: c.id }, c.name)));
    cat.value = r?.category_id || '';
    const dep = h('select', h('option', { value: '' }, '— любой —'), d.departments.map((x) => h('option', { value: x.id }, x.value)));
    dep.value = r?.department_id || '';
    const modeUser = h('input', { type: 'radio', name: 'rmode', checked: !r || r.mode === 'user' });
    const modeLoad = h('input', { type: 'radio', name: 'rmode', checked: r?.mode === 'least_loaded' });
    const who = h('select', h('option', { value: '' }, '— выберите —'), meta.executors.map((x) => h('option', { value: x.id }, x.name)));
    who.value = r?.assignee_id || '';
    const poolBoxes = meta.executors.map((x) => h('input', { type: 'checkbox', value: x.id, checked: (r?.pool || []).includes(x.id) }));
    const poolBox = h('div.stack', { style: { gap: '4px', maxHeight: '160px', overflow: 'auto' } },
      meta.executors.map((x, i) => h('label.check', poolBoxes[i], x.name)));
    const sort = h('input', { type: 'number', value: r?.sort ?? (d.rules.length + 1) * 10, style: { width: '90px' } });
    const active = h('input', { type: 'checkbox', checked: r ? r.is_active : true });
    const userRow = h('label.field', h('span', 'Исполнитель'), who);
    const loadRow = h('div.field', h('span', 'Из кого выбирать (ничего не отмечено — из всех исполнителей)'), poolBox);
    const sync = () => { userRow.hidden = !modeUser.checked; loadRow.hidden = modeUser.checked; };
    modeUser.addEventListener('change', sync); modeLoad.addEventListener('change', sync); sync();
    const save = h('button.btn.primary', 'Сохранить');
    const m = modal({
      title: r ? 'Правило автоназначения' : 'Новое правило',
      body: h('div.stack', { style: { gap: '12px' } },
        h('div.form-grid', h('label.field', h('span', 'Вид проблемы'), cat), h('label.field', h('span', 'Отдел заявителя'), dep)),
        h('div.stack', { style: { gap: '6px' } }, h('strong', 'Кому назначать'),
          h('label.check', modeUser, 'Конкретному исполнителю'),
          h('label.check', modeLoad, 'Наименее загруженному (у кого меньше открытых заявок)')),
        userRow, loadRow,
        h('div.row', { style: { gap: '20px' } }, h('label.row', h('span', 'Порядок'), sort), h('label.check', active, 'Правило включено'))),
      footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
    });
    save.addEventListener('click', () => run(async () => {
      const body = {
        category_id: cat.value || null, department_id: dep.value || null, mode: modeUser.checked ? 'user' : 'least_loaded',
        assignee_id: who.value || null, pool: poolBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
        sort: Number(sort.value) || 0, is_active: active.checked,
      };
      if (r) await api.put('/rules/' + r.id, body); else await api.post('/rules', body);
      m.close(); toast('Сохранено'); reload();
    }, save));
  }
}

// ====================== Заявка за сотрудника ======================
/** Окно «Новая заявка»: служба ИТ записывает обращение сотрудника (звонок, пришёл лично, письмо) */
export function newTicketDialog({ api, meta }) {
  let chosen = null;
  const search = h('input', { type: 'search', placeholder: 'ФИО, телефон, кабинет, отдел или e-mail — от 2 букв', autocomplete: 'off' });
  const found = h('div.stack', { style: { gap: '2px', maxHeight: '180px', overflow: 'auto' } });
  const chosenBox = h('div');
  // Новый сотрудник (если его нет в списке)
  const nName = h('input', { type: 'text', placeholder: 'Фамилия Имя Отчество' });
  const nDep = h('select', h('option', { value: '' }, '— отдел —'), (meta.departments || []).map((d) => h('option', { value: d.id }, d.name)));
  const nPhone = h('input', { type: 'text', placeholder: 'внутренний номер' });
  const nRoom = h('input', { type: 'text', placeholder: 'например, 205' });
  const nEmail = h('input', { type: 'email', placeholder: 'необязательно' });
  const newBox = h('div.form-grid', { style: { display: 'none' } },
    h('label.field', h('span', 'ФИО'), nName), h('label.field', h('span', 'Отдел'), nDep),
    h('label.field', h('span', 'Телефон'), nPhone), h('label.field', h('span', 'Кабинет'), nRoom),
    h('label.field', h('span', 'E-mail'), nEmail,
      h('div.hint', 'Если указать — сотрудник получит письмо о заявке и сможет следить за ней на сайте заявок.')));
  const newLink = h('a', { href: '#' }, '+ сотрудника нет в списке');
  newLink.addEventListener('click', (e) => { e.preventDefault(); chosen = null; drawChosen(); newBox.style.display = ''; nName.value = nName.value || search.value; nName.focus(); });

  function drawChosen() {
    clear(chosenBox, chosen ? h('div.info-box', h('b', chosen.full_name),
      [chosen.department, chosen.room ? `каб. ${chosen.room}` : '', chosen.phone, chosen.email].filter(Boolean).length
        ? ' — ' + [chosen.department, chosen.room ? `каб. ${chosen.room}` : '', chosen.phone, chosen.email].filter(Boolean).join(', ') : '',
      ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); chosen = null; drawChosen(); search.focus(); } }, 'изменить')) : null);
    search.parentElement && (search.parentElement.hidden = !!chosen);
    if (chosen) { newBox.style.display = 'none'; if (!loc.value && chosen.room) loc.value = chosen.room; }
  }
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) { clear(found); return; }
      const list = await api.get('/requesters/search?q=' + encodeURIComponent(q)).catch(() => []);
      clear(found, list.length ? list.map((r) => h('button.btn.subtle', {
        type: 'button', style: { justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '4px 8px' },
        onclick: () => { chosen = r; clear(found); drawChosen(); title.focus(); },
      }, h('span', h('b', r.full_name), h('span.muted.small', ' ' + [r.department, r.room ? `каб. ${r.room}` : '', r.phone].filter(Boolean).join(', ')),
        r.is_active ? null : h('span.muted.small', ' (отключён)')))) : h('span.muted.small', 'Не найдено — добавьте сотрудника ниже'));
    }, 250);
  });

  const channel = h('select', [['phone', 'Позвонил'], ['visit', 'Пришёл лично'], ['email', 'Написал на почту'], ['other', 'Другое']].map(([v, l]) => h('option', { value: v }, l)));
  const cat = h('select', h('option', { value: '' }, '— не указан —'), meta.categories.filter((c) => c.is_active).map((c) => h('option', { value: c.id }, `${c.icon} ${c.name}`)));
  const prio = h('select', Object.entries(meta.priorities).map(([k, l]) => h('option', { value: k, selected: k === 'normal' }, l)));
  const title = h('input', { type: 'text', placeholder: 'Кратко: что случилось' });
  const desc = h('textarea', { rows: 4, placeholder: 'Подробности со слов сотрудника' });
  const loc = h('input', { type: 'text', placeholder: 'Кабинет, рабочее место' });
  const assignee = h('select',
    h('option', { value: 'me' }, 'Взять себе'),
    h('option', { value: 'auto' }, 'По правилам автоназначения'),
    meta.me.isAdmin ? meta.executors.filter((x) => x.id !== meta.me.id).map((x) => h('option', { value: x.id }, x.name)) : null,
    h('option', { value: 'none' }, 'Не назначать'));
  const save = h('button.btn.primary', 'Создать заявку');
  const m = modal({
    title: 'Новая заявка за сотрудника', wide: true,
    body: h('div.stack', { style: { gap: '12px' } },
      h('div.field', h('span', 'Сотрудник'), h('div', search), found, chosenBox, h('div.small', newLink), newBox),
      h('div.form-grid', h('label.field', h('span', 'Как обратился'), channel), h('label.field', h('span', 'Вид проблемы'), cat)),
      h('label.field', h('span', 'Тема'), title),
      h('label.field', h('span', 'Описание'), desc),
      h('div.form-grid', h('label.field', h('span', 'Место'), loc), h('label.field', h('span', 'Приоритет'), prio)),
      h('label.field', h('span', 'Исполнитель'), assignee),
      h('p.hint', 'Срок ставится по нормативу вида проблемы (если он задан) — администратор его подтверждает или меняет в заявке.')),
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
  });
  setTimeout(() => search.focus(), 50);
  save.addEventListener('click', () => run(async () => {
    const body = { title: title.value, description: desc.value, category_id: cat.value || null, priority: prio.value,
      location: loc.value, channel: channel.value, assignee: assignee.value };
    if (chosen) body.requester_id = chosen.id;
    else if (newBox.style.display !== 'none' && nName.value.trim()) {
      body.requester = { full_name: nName.value.trim(), department_id: nDep.value || null, phone: nPhone.value, room: nRoom.value, email: nEmail.value.trim() };
    } else throw new Error('Выберите сотрудника из списка или добавьте нового');
    const r = await api.post('/tickets', body);
    m.close();
    toast(`Заявка #${r.id} создана`);
    location.hash = '#/tickets/' + r.id;
  }, save));
}
