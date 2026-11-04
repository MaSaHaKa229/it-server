// Заявки: рабочее место ИТ-отдела
import { h, clear, makeApi, modal, run, toast, confirmDialog, avatar, fmtDateTime, relTime, toLocalInput, statusPill, parseHash } from '/shared/ui.js';
import { thread, fileList, fileInput, historyList } from '/shared/thread.js';
import { loadMe, topbar, helpdeskUrl } from '/portal/shell.js';

const api = makeApi('/helpdesk/api', {
  onUnauthorized: () => { location.href = '/login?next=' + encodeURIComponent('/helpdesk/' + location.hash); },
});
const fileUrl = (f) => '/helpdesk/api/attachments/' + f.id;

let me, meta;
let main;
let counts = {};

const QUICK = [
  ['open', 'Все открытые', { state: 'open' }],
  ['mine', 'Мои', { state: 'open', assignee: 'me' }],
  ['unassigned', 'Без исполнителя', { state: 'open', assignee: 'none' }],
  ['overdue', 'Просроченные', { overdue: '1' }],
  ['closed', 'Закрытые', { state: 'closed' }],
  ['all', 'Все заявки', {}],
];

async function boot() {
  me = await loadMe();
  await loadMeta();
  const app = document.getElementById('app');
  main = h('main');
  clear(app, topbar(me, 'helpdesk'), main);
  window.addEventListener('hashchange', route);
  route();
}
async function loadMeta() { meta = await api.get('/meta'); }

function layout(active, content) {
  const link = (k, href, label, count, red) => h('a.side-link' + (active === k ? '.active' : ''), { href }, label,
    count != null ? h('span.count' + (red && count ? '.red' : ''), String(count)) : null);
  clear(main, h('div.hd-layout',
    h('aside.hd-side',
      h('h4', 'Заявки'),
      QUICK.map(([k, label]) => link(k, '#/?view=' + k, label,
        { open: counts.open, mine: counts.mine, unassigned: counts.unassigned, overdue: counts.overdue }[k],
        k === 'overdue' || k === 'unassigned')),
      meta.me.isAdmin ? [
        h('h4', 'Настройка'),
        link('categories', '#/categories', 'Виды проблем'),
        link('statuses', '#/statuses', 'Статусы'),
        link('requesters', '#/requesters', 'Сотрудники'),
        link('settings', '#/settings', 'Регистрация и почта'),
      ] : null,
      h('h4', 'Сайт заявок'),
      h('a.side-link', { href: helpdeskUrl(me), target: '_blank', rel: 'noopener' }, '↗ ', helpdeskUrl(me).replace(/^https?:\/\//, ''))),
    h('section', content)));
}

async function route() {
  const { parts, params } = parseHash();
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'tickets' && parts[1]) await renderTicket(Number(parts[1]));
    else if (parts[0] === 'categories' && meta.me.isAdmin) await renderCategories();
    else if (parts[0] === 'statuses' && meta.me.isAdmin) await renderStatuses();
    else if (parts[0] === 'requesters' && meta.me.isAdmin) await renderRequesters();
    else if (parts[0] === 'settings' && meta.me.isAdmin) await renderSettings();
    else await renderList(params);
  } catch (e) {
    layout('', h('div.card.empty', 'Не удалось загрузить: ' + e.message));
  }
}

// ---------------- Список заявок ----------------
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

const listState = { status: '', category: '', assignee: '', priority: '', q: '', sort: '' };

async function renderList(params) {
  const view = params.get('view') || 'open';
  const base = (QUICK.find(([k]) => k === view) || QUICK[0])[2];
  const requester = params.get('requester');
  const tbody = h('tbody');
  const info = h('span.muted.small');

  const sel = (key, options, label) => {
    const s = h('select', { onchange: () => { listState[key] = s.value; load(); } },
      h('option', { value: '' }, label), options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = listState[key];
    return s;
  };
  const search = h('input', { type: 'search', placeholder: 'Поиск: номер, тема, заявитель, кабинет', value: listState.q });
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { listState.q = search.value; load(); }, 250); });

  async function load() {
    const q = new URLSearchParams({ ...base });
    for (const k of ['status', 'category', 'priority', 'q', 'sort']) if (listState[k]) q.set(k, listState[k]);
    if (listState.assignee && !base.assignee) q.set('assignee', listState.assignee);
    if (requester) q.set('requester', requester);
    const res = await api.get('/tickets?' + q);
    counts = res.counts;
    info.textContent = plural(res.tickets.length, 'заявка', 'заявки', 'заявок');
    clear(tbody, res.tickets.length ? res.tickets.map(ticketRow) : h('tr', h('td.empty', { colspan: 8 }, 'Заявок нет')));
    document.querySelectorAll('.hd-side .count').forEach((el) => el.remove());
    sideCounts();
  }
  function sideCounts() {
    document.querySelectorAll('.hd-side a.side-link').forEach((a) => {
      const k = new URLSearchParams(a.getAttribute('href').split('?')[1] || '').get('view');
      const n = { open: counts.open, mine: counts.mine, unassigned: counts.unassigned, overdue: counts.overdue }[k];
      if (n != null) a.append(h('span.count' + ((k === 'overdue' || k === 'unassigned') && n ? '.red' : ''), String(n)));
    });
  }

  layout(view, [
    h('div.page-head', h('h1', (QUICK.find(([k]) => k === view) || QUICK[0])[1]), info,
      requester ? h('a.lozenge.blue', { href: '#/?view=all' }, 'отбор по заявителю ✕') : null),
    h('div.filters',
      search,
      sel('status', meta.statuses.map((s) => [s.id, s.name]), 'Все статусы'),
      sel('category', meta.categories.map((c) => [c.id, c.name]), 'Все виды'),
      base.assignee ? null : sel('assignee', [['me', 'Я'], ['none', 'Без исполнителя'], ...meta.executors.map((x) => [x.id, x.name])], 'Все исполнители'),
      sel('priority', Object.entries(meta.priorities), 'Любой приоритет'),
      sel('sort', [['updated', 'Недавно обновлённые'], ['created', 'Новые'], ['due', 'По сроку'], ['priority', 'По приоритету']], 'Сортировка')),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', '№'), h('th', 'Тема'), h('th', 'Заявитель'), h('th', 'Статус'), h('th', 'Приоритет'),
        h('th', 'Исполнитель'), h('th', 'Срок'), h('th', 'Обновлена'))),
      tbody)),
  ]);
  await load();
}

function ticketRow(t) {
  return h('tr.clickable', { onclick: () => { location.hash = '#/tickets/' + t.id; } },
    h('td.ticket-key', '#' + t.id),
    h('td', h('div.ticket-title', t.title), h('div.muted.small', (t.category_icon || '') + ' ' + (t.category_name || 'Без вида'))),
    h('td', h('div', t.requester_name), h('div.muted.small', [t.requester_department, t.location].filter(Boolean).join(' · '))),
    h('td', statusPill(t.status_name, t.status_color)),
    h('td', h('span.prio.' + t.priority, meta.priorities[t.priority])),
    h('td', t.assignee_name ? h('span.row', avatar(t.assignee_name, 'sm'), t.assignee_name) : h('span.muted', '—')),
    h('td' + (t.is_overdue ? '.overdue' : ''), t.due_at ? fmtDateTime(t.due_at) : h('span.muted', '—')),
    h('td.muted.small', relTime(t.updated_at)));
}

// ---------------- Карточка заявки ----------------
async function renderTicket(id) {
  const t = await api.get('/tickets/' + id);
  const admin = meta.me.isAdmin;
  const mineOrFree = !t.assignee_id || t.assignee_id === me.user.id;
  const reload = () => renderTicket(id);
  const patch = (body, msg = 'Сохранено') => run(async () => { await api.patch('/tickets/' + id, body); toast(msg); await loadMeta(); reload(); });

  // --- свойства ---
  const status = h('select', { disabled: !admin && !mineOrFree, onchange: () => patch({ status_id: Number(status.value) }, 'Статус изменён') },
    meta.statuses.map((s) => h('option', { value: s.id }, s.name + (s.is_closed ? ' (закрыта)' : ''))));
  status.value = t.status_id;

  let assigneeCtl;
  if (admin) {
    const opts = meta.executors.slice();
    if (t.assignee_id && !opts.find((x) => x.id === t.assignee_id)) opts.push({ id: t.assignee_id, name: t.assignee_name });
    assigneeCtl = h('select', { onchange: () => patch({ assignee_id: assigneeCtl.value ? Number(assigneeCtl.value) : null }, 'Исполнитель назначен') },
      h('option', { value: '' }, '— не назначен —'), opts.map((x) => h('option', { value: x.id }, x.name)));
    assigneeCtl.value = t.assignee_id || '';
  } else {
    assigneeCtl = h('div.row',
      t.assignee_name ? [avatar(t.assignee_name, 'sm'), t.assignee_name] : h('span.muted', 'не назначен'),
      !t.assignee_id ? h('button.btn.sm', { onclick: () => patch({ assignee_id: me.user.id }, 'Заявка взята в работу') }, 'Взять себе') : null,
      t.assignee_id === me.user.id ? h('button.btn.sm.subtle', { onclick: () => patch({ assignee_id: null }, 'Вы отказались от заявки') }, 'Отказаться') : null);
  }

  const due = h('input', { type: 'datetime-local', value: toLocalInput(t.due_at), disabled: !admin });
  const dueCtl = admin
    ? h('div.row', due,
      h('button.btn.sm', { onclick: () => patch({ due_at: due.value ? new Date(due.value).toISOString() : null }, 'Срок установлен') }, 'OK'))
    : h('div' + (t.is_overdue ? '.overdue' : ''), t.due_at ? fmtDateTime(t.due_at) : h('span.muted', 'не задан'));
  const quickDue = admin ? h('div.row.wrap', { style: { gap: '4px' } },
    [['+4 ч', 4], ['+1 день', 24], ['+3 дня', 72], ['+неделя', 168]].map(([l, hrs]) =>
      h('button.btn.sm.subtle', { onclick: () => patch({ due_at: new Date(Date.now() + hrs * 3600e3).toISOString() }, 'Срок установлен') }, l)),
    t.due_at ? h('button.btn.sm.subtle', { onclick: () => patch({ due_at: null }, 'Срок снят') }, 'снять') : null) : null;

  const prio = h('select', { disabled: !admin && !mineOrFree, onchange: () => patch({ priority: prio.value }) },
    Object.entries(meta.priorities).map(([k, l]) => h('option', { value: k }, l)));
  prio.value = t.priority;
  const cat = h('select', { disabled: !admin && !mineOrFree, onchange: () => patch({ category_id: cat.value ? Number(cat.value) : null }) },
    h('option', { value: '' }, '— не указан —'), meta.categories.map((c) => h('option', { value: c.id }, `${c.icon} ${c.name}`)));
  cat.value = t.category_id || '';

  // --- техника ---
  const deviceBox = h('div');
  function renderDevice() {
    clear(deviceBox, t.device
      ? h('div.stack', { style: { gap: '4px' } },
        h('a', { href: '/inventory/#/devices/' + t.device.id, target: '_blank' }, `${t.device.key} · ${t.device.hostname || t.device.inv_number || t.device.type_name}`),
        h('div.muted.small', [t.device.type_name, t.device.model, t.device.employee].filter(Boolean).join(' · ')),
        h('button.btn.sm.subtle', { style: { alignSelf: 'flex-start' }, onclick: () => patch({ device_id: null }) }, 'Отвязать'))
      : meta.me.inventory ? h('button.btn.sm', { onclick: pickDevice }, 'Привязать технику') : h('span.muted', '—'));
  }
  function pickDevice() {
    const q = h('input', { type: 'search', placeholder: 'Сетевое имя, инв. номер, модель, сотрудник, кабинет', value: t.location || '' });
    const list = h('div.stack', { style: { gap: '4px', marginTop: '8px' } });
    let timer;
    const search = async () => {
      const rows = await api.get('/devices?q=' + encodeURIComponent(q.value));
      clear(list, rows.length ? rows.map((d) => h('button.cat-opt', { onclick: () => { m.close(); patch({ device_id: d.id }, 'Техника привязана'); } },
        h('div', h('div.t', `${d.key} · ${d.hostname || d.inv_number || ''}`),
          h('div.d', [d.type_name, d.model, d.employee, d.location].filter(Boolean).join(' · '))))) : h('p.muted', 'Ничего не найдено'));
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    const m = modal({ title: 'Техника из ИТ-инвентаря', body: h('div', q, list) });
    search();
  }
  renderDevice();

  // --- ответ ---
  const body = h('textarea', { placeholder: 'Ответ заявителю или внутренняя заметка…' });
  const internal = h('input', { type: 'checkbox' });
  const files = fileInput();
  const send = h('button.btn.primary', {
    onclick: () => run(async () => {
      const fd = new FormData();
      fd.append('body', body.value);
      fd.append('is_internal', internal.checked ? '1' : '0');
      files.files().forEach((f) => fd.append('files', f));
      await api.post(`/tickets/${id}/comments`, fd);
      toast(internal.checked ? 'Заметка добавлена' : 'Ответ отправлен');
      reload();
    }, send),
  }, 'Отправить');
  internal.addEventListener('change', () => { send.textContent = internal.checked ? 'Добавить заметку' : 'Отправить'; });

  const topFiles = t.attachments.filter((a) => !a.comment_id);
  layout('', h('div.ticket-page',
    h('div.stack',
      h('div', h('a', { href: '#/' }, '← Заявки')),
      h('div.card',
        h('div.row.wrap', h('span.ticket-key', '#' + t.id), statusPill(t.status_name, t.status_color),
          t.is_overdue ? h('span.lozenge.red', 'просрочена') : null, h('span.spacer'),
          admin ? h('button.btn.sm.subtle', { onclick: () => editTitle(t, reload) }, 'Изменить тему') : null,
          admin ? h('button.btn.sm.subtle', {
            onclick: async () => {
              if (!await confirmDialog(`Удалить заявку #${t.id}?`, 'Заявка, переписка и файлы будут удалены безвозвратно.')) return;
              run(async () => { await api.del('/tickets/' + id); toast('Заявка удалена'); location.hash = '#/'; });
            },
          }, 'Удалить') : null),
        h('h1', { style: { marginTop: '8px' } }, t.title),
        h('div.muted.small', `${t.category_icon || ''} ${t.category_name || 'Без вида'} · создана ${fmtDateTime(t.created_at)}`),
        h('div.ticket-desc', t.description || h('span.muted', 'Без описания')),
        fileList(topFiles, fileUrl)),
      h('div.card',
        h('h3', 'Переписка'),
        thread(t.comments, t.attachments, { urlFor: fileUrl, isMine: (c) => !!c.user_id }),
        h('div.reply', body, files.el,
          h('div.row.wrap', h('label.check', internal, 'Внутренняя заметка (заявитель не увидит)'), h('span.spacer'), send))),
      t.history.length ? h('div.card', h('h3', 'История'), historyList(t.history)) : null),
    h('div.side-panel',
      h('div.card.stack',
        h('label.prop', h('span', 'Статус'), status),
        h('div.prop', h('span', 'Исполнитель'), assigneeCtl),
        h('div.prop', h('span', 'Срок выполнения'), dueCtl, quickDue),
        h('label.prop', h('span', 'Приоритет'), prio),
        h('label.prop', h('span', 'Вид проблемы'), cat),
        h('div.prop', h('span', 'Техника'), deviceBox)),
      h('div.card.stack', { style: { gap: '6px' } },
        h('h3', 'Заявитель'),
        h('div.row', avatar(t.requester_name), h('div', h('strong', t.requester_name), h('div.muted.small', t.requester_email))),
        t.requester_department ? h('div.small', 'Отдел: ', t.requester_department) : null,
        t.requester_phone ? h('div.small', 'Телефон: ', t.requester_phone) : null,
        h('div.small', 'Место: ', t.location || t.requester_room || '—'),
        h('a.small', { href: '#/?view=all&requester=' + t.requester_id }, `Все заявки сотрудника (${t.requester_ticket_count})`)))));
}

function editTitle(t, done) {
  const title = h('input', { type: 'text', value: t.title });
  const m = modal({
    title: 'Тема заявки', body: title,
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'),
      h('button.btn.primary', { onclick: () => run(async () => { await api.patch('/tickets/' + t.id, { title: title.value }); m.close(); done(); }) }, 'Сохранить')],
  });
}

// ---------------- Виды проблем ----------------
async function renderCategories() {
  await loadMeta();
  layout('categories', [
    h('div.page-head', h('div', h('h1', 'Виды проблем'), h('div.muted', 'Из этого списка сотрудник выбирает, что случилось')),
      h('span.spacer'), h('button.btn.primary', { onclick: () => categoryDialog(null) }, '+ Добавить вид')),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', ''), h('th', 'Название'), h('th', 'Исполнитель по умолчанию'), h('th', 'Срок'), h('th', 'Заявок'), h('th', 'Порядок'), h('th', ''))),
      h('tbody', meta.categories.map((c) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) categoryDialog(c); } },
        h('td', { style: { fontSize: '20px' } }, c.icon),
        h('td', h('strong', c.name), c.is_active ? null : h('span.lozenge', { style: { marginLeft: '6px' } }, 'скрыт'),
          h('div.muted.small', c.description || '')),
        h('td', c.default_assignee_name || h('span.muted', '—')),
        h('td', c.sla_hours ? `${c.sla_hours} ч` : h('span.muted', '—')),
        h('td', c.ticket_count),
        h('td', c.sort),
        h('td', { style: { textAlign: 'right' } }, h('button.btn.subtle.sm', {
          onclick: async () => {
            if (!await confirmDialog(`Удалить «${c.name}»?`, c.ticket_count ? `У ${c.ticket_count} заявок вид станет пустым. Чтобы убрать вид из списка для сотрудников, его можно просто скрыть.` : 'Вид проблемы будет удалён.')) return;
            run(async () => { await api.del('/categories/' + c.id); toast('Удалено'); renderCategories(); });
          },
        }, '🗑'))))))),
  ]);
}

function categoryDialog(c) {
  const name = h('input', { type: 'text', value: c?.name || '' });
  const icon = h('input', { type: 'text', value: c?.icon || '🛠', maxlength: 4, style: { width: '70px' } });
  const desc = h('input', { type: 'text', value: c?.description || '', placeholder: 'Подсказка для сотрудника: что относится к этому виду' });
  const assignee = h('select', h('option', { value: '' }, '— не назначать —'), meta.executors.map((x) => h('option', { value: x.id }, x.name)));
  assignee.value = c?.default_assignee_id || '';
  const sla = h('input', { type: 'number', min: 1, value: c?.sla_hours || '', placeholder: 'не задан' });
  const sort = h('input', { type: 'number', value: c?.sort ?? (meta.categories.length + 1) });
  const active = h('input', { type: 'checkbox', checked: c ? c.is_active : true });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { name: name.value, icon: icon.value, description: desc.value, default_assignee_id: assignee.value || null,
        sla_hours: sla.value, sort: sort.value, is_active: active.checked };
      if (c) await api.put('/categories/' + c.id, body); else await api.post('/categories', body);
      m.close(); toast('Сохранено'); renderCategories();
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: c ? 'Вид проблемы' : 'Новый вид проблемы',
    body: h('div.stack',
      h('div.row', h('label.field', h('span', 'Значок'), icon), h('label.field', { style: { flex: 1 } }, h('span', 'Название'), name)),
      h('label.field', h('span', 'Описание'), desc),
      h('div.grid2',
        h('label.field', h('span', 'Исполнитель по умолчанию'), assignee),
        h('label.field', h('span', 'Срок выполнения, часов'), sla)),
      h('p.hint', 'Новой заявке этого вида сразу назначается исполнитель и срок (если заданы).'),
      h('div.grid2', h('label.field', h('span', 'Порядок в списке'), sort), h('label.check', { style: { alignSelf: 'end' } }, active, 'Показывать сотрудникам'))),
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ---------------- Статусы ----------------
async function renderStatuses() {
  await loadMeta();
  layout('statuses', [
    h('div.page-head', h('div', h('h1', 'Статусы заявок'), h('div.muted', 'Статус «по умолчанию» получает новая заявка. «Закрывающий» статус завершает заявку.')),
      h('span.spacer'), h('button.btn.primary', { onclick: () => statusDialog(null) }, '+ Добавить статус')),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Статус'), h('th', 'Порядок'), h('th', 'Новые заявки'), h('th', 'Закрывает заявку'), h('th', ''))),
      h('tbody', meta.statuses.map((s) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) statusDialog(s); } },
        h('td', statusPill(s.name, s.color)),
        h('td', s.sort),
        h('td', s.is_default ? h('span.lozenge.blue', 'по умолчанию') : ''),
        h('td', s.is_closed ? h('span.lozenge.green', 'да') : ''),
        h('td', { style: { textAlign: 'right' } }, h('button.btn.subtle.sm', {
          onclick: async () => {
            if (!await confirmDialog(`Удалить статус «${s.name}»?`, 'Удалить можно только статус, который не используется в заявках.')) return;
            run(async () => { await api.del('/statuses/' + s.id); toast('Удалено'); renderStatuses(); });
          },
        }, '🗑'))))))),
  ]);
}

function statusDialog(s) {
  const name = h('input', { type: 'text', value: s?.name || '' });
  const color = h('input.color-input', { type: 'color', value: s?.color || '#0052CC' });
  const sort = h('input', { type: 'number', value: s?.sort ?? (meta.statuses.length + 1) });
  const isDefault = h('input', { type: 'checkbox', checked: !!s?.is_default });
  const isClosed = h('input', { type: 'checkbox', checked: !!s?.is_closed });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { name: name.value, color: color.value, sort: sort.value, is_default: isDefault.checked, is_closed: isClosed.checked };
      if (s) await api.put('/statuses/' + s.id, body); else await api.post('/statuses', body);
      m.close(); toast('Сохранено'); renderStatuses();
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: s ? 'Статус' : 'Новый статус',
    body: h('div.stack',
      h('div.row', h('label.field', { style: { flex: 1 } }, h('span', 'Название'), name), h('label.field', h('span', 'Цвет'), color)),
      h('label.field', h('span', 'Порядок'), sort),
      h('label.check', isDefault, 'Присваивать новым заявкам'),
      h('label.check', isClosed, 'Заявка в этом статусе считается закрытой (выполнена, отклонена…)')),
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ---------------- Сотрудники (заявители) ----------------
async function renderRequesters() {
  const list = await api.get('/requesters');
  const tbody = h('tbody');
  const search = h('input', { type: 'search', placeholder: 'Поиск по имени, почте, отделу' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const rows = list.filter((r) => !q || [r.full_name, r.email, r.department, r.room].some((v) => (v || '').toLowerCase().includes(q)));
    clear(tbody, rows.length ? rows.map((r) => h('tr',
      h('td', h('div.row', avatar(r.full_name, 'sm'), h('div', h('strong', r.full_name), h('div.muted.small', r.email)))),
      h('td', h('div', r.department || '—'), h('div.muted.small', [r.position, r.room, r.phone].filter(Boolean).join(' · '))),
      h('td', h('a', { href: '#/?view=all&requester=' + r.id }, String(r.tickets)), r.open_tickets ? h('span.muted.small', ` (откр. ${r.open_tickets})`) : null),
      h('td.muted.small', fmtDateTime(r.created_at)),
      h('td.muted.small', r.last_login ? relTime(r.last_login) : 'не входил'),
      h('td', !r.is_approved ? h('span.lozenge.orange', 'ждёт подтверждения')
        : !r.email_verified ? h('span.lozenge', 'почта не подтверждена')
          : r.is_active ? h('span.lozenge.green', 'активен') : h('span.lozenge.red', 'заблокирован')),
      h('td.nowrap', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        !r.is_approved ? h('button.btn.sm.primary', { onclick: () => upd(r, { is_approved: true }, 'Регистрация подтверждена') }, 'Подтвердить') : null,
        r.is_approved ? h('button.btn.sm.subtle', { onclick: () => upd(r, { is_active: !r.is_active }, r.is_active ? 'Заблокирован' : 'Разблокирован') }, r.is_active ? 'Заблокировать' : 'Разблокировать') : null,
        h('button.btn.sm.subtle', { onclick: () => requesterDialog(r) }, 'Изменить'))))
      : h('tr', h('td.empty', { colspan: 7 }, list.length ? 'Никого не найдено' : 'Пока никто не зарегистрировался')));
  };
  const upd = (r, body, msg) => run(async () => { await api.patch('/requesters/' + r.id, body); toast(msg); renderRequesters(); });
  search.addEventListener('input', fill);
  const pending = list.filter((r) => !r.is_approved).length;
  layout('requesters', [
    h('div.page-head', h('div', h('h1', 'Зарегистрированные сотрудники'),
      h('div.muted', `Всего: ${list.length}` + (pending ? ` · ждут подтверждения: ${pending}` : '')))),
    h('div.filters', search),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Сотрудник'), h('th', 'Отдел'), h('th', 'Заявок'), h('th', 'Регистрация'), h('th', 'Вход'), h('th', 'Состояние'), h('th', ''))),
      tbody)),
  ]);
  fill();
}

function requesterDialog(r) {
  const f = {};
  const field = (k, label) => { f[k] = h('input', { type: 'text', value: r[k] || '' }); return h('label.field', h('span', label), f[k]); };
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Оставьте пустым, чтобы не менять' });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      if (pw.value) body.password = pw.value;
      await api.patch('/requesters/' + r.id, body);
      m.close(); toast('Сохранено'); renderRequesters();
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: r.email, wide: true,
    body: h('div.stack',
      h('div.grid2', field('full_name', 'ФИО'), field('department', 'Отдел'), field('position', 'Должность'),
        field('phone', 'Телефон'), field('room', 'Кабинет')),
      h('label.field', h('span', 'Новый пароль (если сотрудник забыл свой)'), pw)),
    footer: [
      h('button.btn.subtle', {
        style: { marginRight: 'auto', color: 'var(--danger)' },
        onclick: async () => {
          if (!await confirmDialog(`Удалить ${r.email}?`, 'Вместе с учётной записью будут удалены все заявки этого сотрудника. Обычно достаточно заблокировать.')) return;
          run(async () => { await api.del('/requesters/' + r.id); m.close(); toast('Удалено'); renderRequesters(); });
        },
      }, 'Удалить'),
      h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ---------------- Настройки регистрации ----------------
async function renderSettings() {
  await loadMeta();
  const s = meta.settings;
  const domains = h('input', { type: 'text', value: s.allowed_domains.join(', '), placeholder: 'company.local, company.ru' });
  const approval = h('input', { type: 'checkbox', checked: s.require_approval });
  const welcome = h('textarea', { value: s.welcome_text });
  welcome.value = s.welcome_text;
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      await api.put('/settings', { allowed_domains: domains.value, require_approval: approval.checked, welcome_text: welcome.value });
      toast('Настройки сохранены'); renderSettings();
    }, save),
  }, 'Сохранить');
  layout('settings', [
    h('div.page-head', h('h1', 'Регистрация и почта')),
    h('div.card.stack', { style: { maxWidth: '720px' } },
      h('label.field', h('span', 'Домены внутренней почты'), domains),
      h('p.hint', 'Зарегистрироваться смогут только адреса этих доменов (через запятую). Пусто — любой адрес.'),
      h('label.check', approval, 'Подтверждать регистрации вручную (новый сотрудник ждёт, пока администратор его подтвердит)'),
      h('label.field', h('span', 'Текст на главной странице сайта заявок'), welcome),
      h('div', save)),
    h('div.card.stack', { style: { maxWidth: '720px', marginTop: '16px' } },
      h('h3', 'Почта'),
      meta.mailEnabled
        ? h('div.ok-box', 'SMTP настроен: сотрудники подтверждают регистрацию кодом из письма, могут восстановить пароль и получают уведомления о заявках. Исполнители и администраторы получают письма о новых и назначенных заявках (на e-mail из профиля портала).')
        : h('div.info-box', 'SMTP не настроен — письма не отправляются. Регистрация работает без подтверждения почты; ',
          'чтобы проверять, что зарегистрировался именно сотрудник, включите ручное подтверждение выше. ',
          'Для отправки писем укажите SMTP_HOST и другие параметры в файле .env и перезапустите портал.'),
      h('div.muted.small', 'Адрес сайта заявок: ', h('a', { href: helpdeskUrl(me), target: '_blank' }, helpdeskUrl(me)))),
  ]);
}

boot().catch((e) => { document.getElementById('app').textContent = 'Ошибка загрузки: ' + e.message; });
