// Администрирование портала: пользователи и доступ к разделам
import { h, clear, modal, run, toast, confirmDialog, avatar, fmtDateTime, sortHead, sortRows, savedSort } from '/shared/ui.js';
import { api, loadMe, portalTopbar } from './shell.js';

let me, meta, users = [];
const filter = { q: '', inactive: false };
const MOD_ORDER = ['inventory', 'docs', 'calendar', 'helpdesk'];
const MOD_HINT = {
  inventory: 'Просмотр — только то, что разрешено в настройках читателя (типы техники, отделы, поля, пароли). Редактирование — добавление и изменение техники, справочников, импорт.',
  docs: 'Просмотр — поиск, чтение и скачивание документов. Редактирование — добавление, изменение и удаление документов.',
  calendar: 'Просмотр — календарь и задачи без изменений. Редактирование — создание и изменение задач, комментарии. Администратор — плюс удаление категорий и журнал.',
  helpdesk: 'Исполнитель — видит все заявки, берёт их в работу, меняет статус своих, переписывается с заявителем. Администратор — назначает исполнителей и сроки, настраивает виды проблем, статусы и регистрацию сотрудников.',
};
// Готовые наборы прав
const PRESETS = [
  ['Сотрудник ИТ-отдела', { inventory: 'edit', docs: 'edit', calendar: 'edit', helpdesk: 'executor' }],
  ['Только просмотр', { inventory: 'view', docs: 'view', calendar: 'view', helpdesk: 'none' }],
  ['Без доступа', { inventory: 'none', docs: 'none', calendar: 'none', helpdesk: 'none' }],
];

async function main() {
  me = await loadMe();
  meta = await api.get('/api/admin/meta');
  await render();
}

// Сортировка: запоминается в браузере
const sort = savedSort('admin-users', { key: 'name', dir: 1 });
// Порядок уровней доступа для сортировки по разделу: «нет» < «просмотр» < … < «администратор»
const rank = (u, m) => (u.role === 'superadmin' ? 99 : Object.keys(meta.modules[m].levels).indexOf((u.modules || {})[m] || 'none'));

function columns() {
  return [
    { key: 'name', label: 'Пользователь', value: (u) => u.full_name || u.username },
    { key: 'username', label: 'Логин' },
    { key: 'email', label: 'E-mail' },
    ...MOD_ORDER.map((m) => ({ key: 'mod_' + m, label: meta.modules[m].label, value: (u) => rank(u, m) })),
    { key: 'last_login', label: 'Последний вход', value: (u) => (u.last_login ? new Date(u.last_login).getTime() : null) },
    { key: 'status', label: 'Статус', value: (u) => (u.is_active ? 0 : 1) },
    { label: '', sortable: false },
  ];
}

async function render() {
  users = await api.get('/api/admin/users');
  const app = document.getElementById('app');
  const table = h('table.list');
  const info = h('span.badge');
  const search = h('input', { type: 'search', placeholder: 'Поиск по имени, логину, e-mail', value: filter.q,
    oninput: () => { filter.q = search.value; fill(); } });
  const showInactive = h('input', { type: 'checkbox', checked: filter.inactive, onchange: () => { filter.inactive = showInactive.checked; fill(); } });

  function fill() {
    const q = filter.q.trim().toLowerCase();
    const cols = columns();
    const list = sortRows(users.filter((u) => (filter.inactive || u.is_active)
      && (!q || [u.full_name, u.username, u.email].some((v) => (v || '').toLowerCase().includes(q)))), cols, sort);
    info.textContent = String(list.length);
    clear(table, sortHead(cols, sort, fill),
      h('tbody', list.length ? list.map(row) : h('tr.empty', h('td', { colspan: cols.length }, 'Никого не найдено'))));
  }

  clear(app,
    portalTopbar(me, 'admin'),
    h('div.layout', h('main.main.full', h('div',
      h('div.breadcrumbs', h('a', { href: '/' }, 'ИТ-портал'), h('span.sep', '/'), h('span', 'Администрирование')),
      h('div.page-head',
        h('h1', 'Пользователи и доступ'), info,
        h('span.spacer'),
        h('button.btn.primary', { onclick: () => userDialog(null) }, '+ Создать пользователя')),
      h('p.muted', { style: { margin: '-8px 0 16px' } }, 'Учётные записи сотрудников ИТ-отдела и права на разделы портала. Нажмите на заголовок столбца, чтобы отсортировать.'),
      h('div.toolbar', h('div.search-box', search), h('label.check', showInactive, 'Показывать отключённых')),
      h('div.table-wrap', table),
      h('p.hint', { style: { marginTop: '12px' } },
        'Сотрудники предприятия, которые подают заявки в ИТ-отдел, регистрируются сами на сайте заявок — ',
        'их список в разделе «Заявки» → «Сотрудники».')))));
  fill();
}

function levelCell(u, mod) {
  if (u.role === 'superadmin') return h('td.access-cell', h('span.lozenge.purple', 'полный'));
  const lv = (u.modules || {})[mod] || 'none';
  const label = meta.modules[mod].levels[lv];
  const extra = [];
  if (mod === 'docs' && lv !== 'none' && Array.isArray(u.modules.docs_types) && u.modules.docs_types.length) extra.push('часть видов');
  if (mod === 'calendar' && lv !== 'none' && lv !== 'admin' && u.modules.calendar_own_only) extra.push('только свои');
  if (mod === 'inventory' && lv === 'view') extra.push('по настройкам читателя');
  const cls = { view: '', edit: '.green', admin: '.purple', executor: '.blue' }[lv] ?? '';
  return h('td.access-cell', lv === 'none' ? h('span.muted', '—') : h('span.lozenge' + cls, label),
    extra.length ? h('span.muted.small', { style: { marginLeft: '6px' } }, extra.join(', ')) : null);
}

function row(u) {
  const name = u.full_name || u.username;
  return h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) userDialog(u); } },
    h('td', h('span.row', avatar(name, 'sm'), h('strong', name),
      u.role === 'superadmin' ? h('span.lozenge.purple', 'админ') : null)),
    h('td.mono', u.username),
    h('td.muted', u.email || '—'),
    MOD_ORDER.map((m) => levelCell(u, m)),
    h('td.muted.small', u.last_login ? fmtDateTime(u.last_login) : 'никогда'),
    h('td', u.is_active ? h('span.lozenge.green', 'активен') : h('span.lozenge.red', 'отключён')),
    h('td.nowrap', { style: { textAlign: 'right' } }, u.id !== me.user.id ? h('button.btn.subtle.sm', {
      title: 'Удалить',
      onclick: async () => {
        if (!await confirmDialog(`Удалить пользователя ${u.username}?`,
          'Учётная запись будет удалена. Созданные им записи сохранятся без автора. Чтобы временно закрыть доступ, лучше отключите пользователя.')) return;
        run(async () => { await api.del('/api/admin/users/' + u.id); toast('Пользователь удалён'); render(); });
      },
    }, 'Удалить') : null));
}

function userDialog(u) {
  const isNew = !u;
  const mods = { ...(u?.modules || { inventory: 'view', docs: 'view', calendar: 'view', helpdesk: 'none' }) };
  const username = h('input', { type: 'text', value: u?.username || '', disabled: !isNew, autocomplete: 'off', placeholder: 'ivanov' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? 'Не короче 8 символов' : 'Оставьте пустым, чтобы не менять' });
  const fullName = h('input', { type: 'text', value: u?.full_name || '', placeholder: 'Иванов Иван Иванович' });
  const email = h('input', { type: 'email', value: u?.email || '', placeholder: 'ivanov@company.local' });
  const active = h('input', { type: 'checkbox', checked: u ? u.is_active : true });
  const isAdmin = h('input', { type: 'checkbox', checked: u?.role === 'superadmin' });
  const self = u && u.id === me.user.id;
  if (self) { isAdmin.disabled = true; active.disabled = true; }

  const modsBox = h('div');
  // Ограничение по видам документов
  const docTypesSel = new Set(Array.isArray(mods.docs_types) ? mods.docs_types : []);
  const docAll = h('input', { type: 'checkbox', checked: !docTypesSel.size });
  const docBoxes = Object.entries(meta.docTypes).map(([k, label]) => {
    const cb = h('input', { type: 'checkbox', value: k, checked: !docTypesSel.size || docTypesSel.has(k), disabled: !docTypesSel.size });
    return h('label.check', cb, label);
  });
  docAll.addEventListener('change', () => docBoxes.forEach((l) => {
    const cb = l.querySelector('input'); cb.disabled = docAll.checked; if (docAll.checked) cb.checked = true;
  }));
  const ownOnly = h('input', { type: 'checkbox', checked: !!mods.calendar_own_only });

  function renderMods() {
    const admin = isAdmin.checked;
    clear(modsBox,
      h('h3', { style: { margin: '8px 0 4px' } }, 'Доступ к разделам'),
      admin
        ? h('div.info-box', 'Администратор портала имеет полный доступ ко всем разделам и управляет пользователями.')
        : h('div.stack',
          h('div.row.wrap', h('span.muted.small', 'Быстро задать:'),
            PRESETS.map(([label, p]) => h('button.btn.sm', { type: 'button', onclick: () => { Object.assign(mods, p); renderMods(); } }, label))),
          h('div.mod-grid', MOD_ORDER.map((m) => [
            h('div.mod-name', meta.modules[m].label),
            h('div',
              h('div.levels', Object.entries(meta.modules[m].levels).map(([lv, label]) => {
                const on = (mods[m] || 'none') === lv;
                return h('label.level-opt' + (on ? '.on' : ''),
                  h('input', { type: 'radio', name: 'lv-' + m, checked: on, onchange: () => { mods[m] = lv; renderMods(); } }), label);
              })),
              h('p.hint', { style: { marginTop: '4px' } }, MOD_HINT[m]),
              m === 'inventory' && mods.inventory === 'view' && u
                ? h('div.mod-extra.small', 'Что именно видит читатель (типы техники, отделы, поля, ПО, пароли, выгрузка), настраивается в ',
                  h('a', { href: '/inventory/#/users', target: '_blank' }, 'ИТ-инвентарь → Пользователи'), '.')
                : null,
              m === 'inventory' && mods.inventory === 'view' && !u
                ? h('div.mod-extra.small', 'По умолчанию читатель видит всю технику, кроме паролей. Ограничить можно после создания в «ИТ-инвентарь → Пользователи».')
                : null,
              m === 'docs' && mods.docs !== 'none'
                ? h('div.mod-extra', h('div.row.wrap', h('strong.small', 'Виды документов:'), h('label.check.small', docAll, 'все')),
                  h('div.row.wrap', { style: { marginTop: '6px', gap: '12px' } }, docBoxes))
                : null,
              m === 'calendar' && ['view', 'edit'].includes(mods.calendar)
                ? h('div.mod-extra', h('label.check.small', ownOnly, 'Видит только свои задачи (где он автор или исполнитель)'))
                : null),
          ]))));
  }
  isAdmin.addEventListener('change', renderMods);
  renderMods();

  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const types = docAll.checked ? null : docBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value);
      if (types && !types.length && mods.docs !== 'none') throw new Error('Отметьте хотя бы один вид документов или выберите «Нет доступа»');
      const body = {
        username: username.value.trim(), password: password.value || undefined,
        full_name: fullName.value, email: email.value, is_active: active.checked, is_admin: isAdmin.checked,
        modules: { ...mods, docs_types: types, calendar_own_only: ownOnly.checked },
      };
      if (isNew) await api.post('/api/admin/users', body); else await api.put('/api/admin/users/' + u.id, body);
      m.close(); toast(isNew ? 'Пользователь создан' : 'Сохранено'); render();
    }, save),
  }, isNew ? 'Создать' : 'Сохранить');

  const m = modal({
    title: isNew ? 'Новый пользователь' : `Пользователь ${u.username}`, wide: true,
    body: h('div.stack', { style: { gap: '16px' } },
      h('div.form-grid',
        h('label.field', h('span', 'Логин'), username),
        h('label.field', h('span', isNew ? 'Пароль' : 'Новый пароль'), password),
        h('label.field', h('span', 'ФИО'), fullName),
        h('label.field', h('span', 'E-mail'), email)),
      h('div.row.wrap', { style: { gap: '24px' } },
        h('label.check', active, 'Учётная запись активна'),
        h('label.check', isAdmin, h('span', h('strong', 'Администратор портала'), h('span.muted', ' — полный доступ и управление пользователями')))),
      modsBox),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

main().catch((e) => { document.getElementById('app').textContent = 'Ошибка загрузки: ' + e.message; });
