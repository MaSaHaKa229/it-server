// Администрирование портала: пользователи и доступ к разделам
import { h, clear, modal, run, toast, confirmDialog, avatar, fmtDateTime, sortHead, sortRows, savedSort } from '/shared/ui.js';
import { api, loadMe, portalTopbar } from './shell.js';
import { renderMailNotify, renderBackup, renderAudit, renderSettingsMap, renderStatus, renderBranding } from './admin-extra.js';

let me, meta, users = [];
const filter = { q: '', inactive: false };
const MOD_ORDER = ['inventory', 'docs', 'calendar', 'helpdesk', 'remote'];
const MOD_HINT = {
  inventory: 'Просмотр — только то, что разрешено в настройках читателя (типы техники, отделы, поля, пароли). Редактирование — добавление и изменение техники, справочников, импорт.',
  docs: 'Просмотр — поиск, чтение и скачивание документов. Редактирование — добавление, изменение и удаление документов.',
  calendar: 'Просмотр — календарь и задачи без изменений (какие задачи и чьи отпуска видны — настраивается ниже). Редактирование — создание и изменение задач, комментарии. Администратор — плюс удаление категорий и журнал.',
  helpdesk: 'Исполнитель — видит все заявки, берёт их в работу, меняет статус своих, переписывается с заявителем. Администратор — назначает исполнителей и сроки, настраивает виды проблем, статусы и регистрацию сотрудников.',
  remote: 'Подключение к компьютерам пользователей. Только просмотр — видеть экран без управления. Управление — мышь и клавиатура. Администратор — плюс журнал всех подключений, настройки, установка агентов.',
};
// Готовые наборы прав
const PRESETS = [
  ['Сотрудник службы ИТ', { inventory: 'edit', docs: 'edit', calendar: 'edit', helpdesk: 'executor', remote: 'control' }],
  ['Только просмотр', { inventory: 'view', docs: 'view', calendar: 'view', helpdesk: 'none', remote: 'none' }],
  ['Без доступа', { inventory: 'none', docs: 'none', calendar: 'none', helpdesk: 'none', remote: 'none' }],
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

// Вкладки администрирования (адрес: /admin#backup и т. п.)
const TABS = [['users', 'Пользователи и доступ'], ['settings', 'Все настройки'], ['notify', 'Уведомления и почта'], ['backup', 'Резервные копии'], ['audit', 'Журнал входов и действий'], ['status', 'Состояние системы'], ['branding', 'Оформление']];
const currentTab = () => (TABS.find(([k]) => location.hash === '#' + k) || TABS[0])[0];
const tabsEl = () => h('div.tabs', { style: { marginBottom: '16px' } }, TABS.map(([k, l]) =>
  h('a.tab' + (currentTab() === k ? '.active' : ''), { href: '#' + k }, l)));
window.addEventListener('hashchange', () => render());

async function render() {
  const tab = currentTab();
  if (tab !== 'users') {
    const app = document.getElementById('app');
    const body = h('div');
    clear(app,
      portalTopbar(me, 'admin'),
      h('div.layout', h('main.main.full', h('div',
        h('div.breadcrumbs', h('a', { href: '/' }, 'ИТ-портал'), h('span.sep', '/'), h('span', 'Администрирование')),
        h('div.page-head', h('h1', TABS.find(([k]) => k === tab)[1])),
        tabsEl(), body))));
    await ({ settings: renderSettingsMap, notify: renderMailNotify, backup: renderBackup, audit: renderAudit, status: renderStatus, branding: renderBranding })[tab](body);
    return;
  }
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
      tabsEl(),
      h('p.muted', { style: { margin: '-8px 0 16px' } }, 'Учётные записи сотрудников службы ИТ и права на разделы портала. Нажмите на заголовок столбца, чтобы отсортировать.'),
      h('div.toolbar', h('div.search-box', search), h('label.check', showInactive, 'Показывать отключённых')),
      h('div.table-wrap', table),
      h('p.hint', { style: { marginTop: '12px' } },
        'Сотрудники предприятия, которые подают заявки в службу ИТ, регистрируются сами на сайте заявок — ',
        'их список в разделе «Заявки» → «Заявители».')))));
  fill();
}

function levelCell(u, mod) {
  if (u.role === 'superadmin') return h('td.access-cell', h('span.lozenge.purple', 'полный'));
  const lv = (u.modules || {})[mod] || 'none';
  const label = meta.modules[mod].levels[lv];
  const extra = [];
  if (mod === 'docs' && lv !== 'none' && Array.isArray(u.modules.docs_types) && u.modules.docs_types.length) extra.push('часть видов');
  if (mod === 'docs' && lv !== 'none' && Array.isArray(u.modules.docs_folders)) extra.push(`папок: ${u.modules.docs_folders.length}`);
  if (mod === 'calendar' && lv !== 'none' && lv !== 'admin' && u.modules.calendar_own_only) extra.push('только свои');
  else if (mod === 'calendar' && lv === 'view' && (Array.isArray(u.modules.calendar_cats) || Array.isArray(u.modules.calendar_people))) extra.push('выбранные задачи');
  if (mod === 'calendar' && lv === 'view' && u.modules.calendar_absences === 'none') extra.push('без отсутствий');
  else if (mod === 'calendar' && lv === 'view' && Array.isArray(u.modules.calendar_absences)) extra.push('часть отсутствий');
  if (mod === 'inventory' && lv === 'view') extra.push('по настройкам читателя');
  const cls = { view: '', edit: '.green', admin: '.purple', executor: '.blue' }[lv] ?? '';
  return h('td.access-cell', lv === 'none' ? h('span.muted', '—') : h('span.lozenge' + cls, label),
    extra.length ? h('span.muted.small', { style: { marginLeft: '6px' } }, extra.join(', ')) : null);
}

/**
 * Уровень «Просмотр» в календаре: какие задачи и чьи отсутствия видит сотрудник.
 * Задачи: все / только свои / выбранные (категории и исполнители; свои видны всегда). Отсутствия: все / никакие / выбранных сотрудников.
 */
function calendarViewScope(mods) {
  const cats = [{ id: 0, name: 'Без категории' }, ...(meta.calCategories || [])];
  const people = [{ id: 0, name: 'Без исполнителя' }, ...(meta.calPeople || [])];
  const absPeople = meta.calPeople || [];
  const selected = Array.isArray(mods.calendar_cats) || Array.isArray(mods.calendar_people);
  let taskMode = mods.calendar_own_only ? 'own' : selected ? 'selected' : 'all';
  let absMode = mods.calendar_absences === 'none' ? 'none' : Array.isArray(mods.calendar_absences) ? 'selected' : 'all';

  // Список с галочкой «все»: при «все» отдельные галочки недоступны
  function picker(title, items, current, swatch) {
    const all = h('input', { type: 'checkbox', checked: !Array.isArray(current) });
    const set = new Set(Array.isArray(current) ? current : []);
    const boxes = items.map((x) => h('input', { type: 'checkbox', value: x.id, checked: !Array.isArray(current) || set.has(x.id) }));
    const sync = () => boxes.forEach((b) => { b.disabled = all.checked; if (all.checked) b.checked = true; });
    all.addEventListener('change', sync);
    sync();
    return {
      el: h('div', { style: { marginTop: '8px' } },
        h('div.row', h('strong.small', title), h('label.check.small', all, 'все')),
        h('div.stack', { style: { marginTop: '6px', gap: '4px', maxHeight: '180px', overflowY: 'auto' } },
          items.map((x, i) => h('label.check.small', boxes[i],
            swatch && x.color ? h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: x.color, marginRight: '4px' } }) : null,
            x.id === 0 ? h('i', x.name) : x.name)))),
      value: () => (all.checked ? null : boxes.filter((b) => b.checked).map((b) => Number(b.value))),
    };
  }
  const catPick = picker('Категории:', cats, mods.calendar_cats, true);
  const peoplePick = picker('Исполнители:', people, mods.calendar_people);
  const absPick = picker('Сотрудники:', absPeople, Array.isArray(mods.calendar_absences) ? mods.calendar_absences : null);

  const taskBox = h('div');
  const absBox = h('div');
  const radios = (name, opts, cur, onChange) => h('div.row.wrap', { style: { gap: '14px', marginTop: '4px' } },
    opts.map(([v, label]) => h('label.check.small',
      h('input', { type: 'radio', name, checked: cur === v, onchange: () => onChange(v) }), label)));
  const uid = Math.random().toString(36).slice(2);
  function draw() {
    clear(taskBox,
      radios('calt-' + uid, [['all', 'все задачи'], ['own', 'только свои'], ['selected', 'выбранные']], taskMode, (v) => { taskMode = v; draw(); }),
      taskMode === 'own' ? h('p.hint', 'Задачи, где сотрудник автор или исполнитель.') : null,
      taskMode === 'selected' ? [
        h('p.hint', 'Видны задачи отмеченных категорий, у которых среди исполнителей есть отмеченные сотрудники. Свои задачи видны всегда.'),
        catPick.el, peoplePick.el] : null);
    clear(absBox,
      radios('cala-' + uid, [['all', 'всех сотрудников'], ['none', 'не показывать'], ['selected', 'выбранных сотрудников']], absMode, (v) => { absMode = v; draw(); }),
      absMode === 'selected' ? [h('p.hint', 'Свои отсутствия видны всегда.'), absPick.el] : null);
  }
  draw();
  return {
    el: h('div.mod-extra',
      h('strong.small', 'Какие задачи видит:'), taskBox,
      h('div', { style: { marginTop: '12px' } }, h('strong.small', 'Отпуска и другие отсутствия:'), absBox)),
    value() {
      const out = { calendar_own_only: taskMode === 'own', calendar_cats: null, calendar_people: null, calendar_absences: 'all' };
      if (taskMode === 'selected') {
        out.calendar_cats = catPick.value();
        out.calendar_people = peoplePick.value();
        if (out.calendar_cats && !out.calendar_cats.length) throw new Error('Отметьте хотя бы одну категорию задач или выберите «все задачи»');
        if (out.calendar_people && !out.calendar_people.length) throw new Error('Отметьте хотя бы одного исполнителя или выберите «все задачи»');
        // «Выбранные» без единого ограничения — то же, что «все задачи»
      }
      if (absMode === 'none') out.calendar_absences = 'none';
      if (absMode === 'selected') {
        out.calendar_absences = absPick.value() || 'all';
      }
      return out;
    },
  };
}

function row(u) {
  const name = u.full_name || u.username;
  return h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) userDialog(u); } },
    h('td', h('span.row', avatar(name, 'sm'), h('strong', name),
      u.role === 'superadmin' ? h('span.lozenge.purple', 'админ') : null,
      u.is_service ? h('span.lozenge', { title: 'Не показывается в списках людей; вместо имени — «Служба ИТ»' }, 'служебная') : null)),
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
  const mods = { ...(u?.modules || { inventory: 'view', docs: 'view', calendar: 'view', helpdesk: 'none', remote: 'none' }) };
  const username = h('input', { type: 'text', value: u?.username || '', disabled: !isNew, autocomplete: 'off', placeholder: 'ivanov' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? 'Не короче 8 символов' : 'Оставьте пустым, чтобы не менять' });
  const fullName = h('input', { type: 'text', value: u?.full_name || '', placeholder: 'Иванов Иван Иванович' });
  const email = h('input', { type: 'email', value: u?.email || '', placeholder: 'ivanov@company.local' });
  const active = h('input', { type: 'checkbox', checked: u ? u.is_active : true });
  const isAdmin = h('input', { type: 'checkbox', checked: u?.role === 'superadmin' });
  const isService = h('input', { type: 'checkbox', checked: !!u?.is_service });
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
  // Доступ по папкам документов: «все» или отмеченные (вложенные открываются вместе с папкой)
  const folderSel = new Set(Array.isArray(mods.docs_folders) ? mods.docs_folders : []);
  const folderAll = h('input', { type: 'checkbox', checked: !Array.isArray(mods.docs_folders) });
  const folderBoxes = (meta.docFolders || []).map((f) => {
    const cb = h('input', { type: 'checkbox', value: f.id, checked: folderSel.has(f.id) });
    return { f, cb, el: h('label.check', { style: { paddingLeft: (f.depth * 20) + 'px', display: 'flex' }, title: f.path }, cb, '📁 ' + f.name) };
  });
  // Отмеченная папка открывает вложенные: показываем их отмеченными и недоступными для снятия
  function syncFolders() {
    const on = new Set(folderBoxes.filter((x) => x.cb.dataset.own === '1').map((x) => x.f.id));
    for (const x of folderBoxes) {
      const inherited = !folderAll.checked && x.f.parent_id && (on.has(x.f.parent_id) || folderBoxes.find((y) => y.f.id === x.f.parent_id)?.cb.dataset.inh === '1');
      x.cb.dataset.inh = inherited ? '1' : '';
      x.cb.disabled = folderAll.checked || !!inherited;
      x.cb.checked = folderAll.checked || !!inherited || x.cb.dataset.own === '1';
    }
  }
  for (const x of folderBoxes) {
    x.cb.dataset.own = folderSel.has(x.f.id) ? '1' : '';
    x.cb.addEventListener('change', () => { x.cb.dataset.own = x.cb.checked ? '1' : ''; syncFolders(); });
  }
  folderAll.addEventListener('change', syncFolders);
  syncFolders();
  const ownOnly = h('input', { type: 'checkbox', checked: !!mods.calendar_own_only });
  const calView = calendarViewScope(mods);

  function renderMods() {
    const admin = isAdmin.checked;
    clear(modsBox,
      h('h3', { style: { margin: '8px 0 4px' } }, 'Доступ к разделам'),
      admin
        ? h('div.stack',
          h('div.info-box', 'Администратор портала имеет полный доступ ко всем разделам и управляет пользователями.'),
          h('label.check', isService, h('span', h('strong', 'Служебная учётная запись'),
            h('span.muted', ' — не показывается в списках людей (исполнители, фильтры, отпуска, статистика), в истории и переписке вместо имени — «Служба ИТ». '
              + 'Отмечайте только общую учётную запись (например, admin); администраторов-сотрудников не отмечайте.'))))
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
                ? [h('div.mod-extra',
                  h('div.row', h('strong.small', 'Папки:'), h('label.check.small', folderAll, 'все папки и документы без папки')),
                  folderBoxes.length
                    ? h('div.stack', { style: { marginTop: '8px', gap: '4px', maxHeight: '220px', overflowY: 'auto' } }, folderBoxes.map((x) => x.el))
                    : h('p.hint', 'Папок пока нет — их создают в разделе «Документы → Папки и теги».'),
                  h('p.hint', 'Сотрудник видит только документы в отмеченных папках. Отметка папки открывает и все вложенные в неё.')),
                h('div.mod-extra', h('div.row.wrap', h('strong.small', 'Виды документов:'), h('label.check.small', docAll, 'все')),
                  h('div.row.wrap', { style: { marginTop: '6px', gap: '12px' } }, docBoxes))]
                : null,
              m === 'calendar' && mods.calendar === 'edit'
                ? h('div.mod-extra', h('label.check.small', ownOnly, 'Видит только свои задачи (где он автор или исполнитель)'))
                : null,
              m === 'calendar' && mods.calendar === 'view' ? calView.el : null),
          ]))));
  }
  isAdmin.addEventListener('change', renderMods);
  renderMods();

  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const types = docAll.checked ? null : docBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value);
      if (types && !types.length && mods.docs !== 'none') throw new Error('Отметьте хотя бы один вид документов или выберите «Нет доступа»');
      const folderIds = folderAll.checked ? null : folderBoxes.filter((x) => x.cb.dataset.own === '1' && x.cb.dataset.inh !== '1').map((x) => x.f.id);
      if (folderIds && !folderIds.length && mods.docs !== 'none') throw new Error('Отметьте хотя бы одну папку документов, «все папки» или выберите «Нет доступа»');
      const body = {
        username: username.value.trim(), password: password.value || undefined,
        full_name: fullName.value, email: email.value, is_active: active.checked, is_admin: isAdmin.checked, is_service: isAdmin.checked && isService.checked,
        modules: { ...mods, docs_types: types, docs_folders: folderIds,
          ...(mods.calendar === 'view' ? calView.value() : { calendar_own_only: ownOnly.checked }) },
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
