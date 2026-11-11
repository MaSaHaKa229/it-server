// Точка входа: авторизация, каркас страницы (как в Jira), маршрутизация
import { h, clear, icon, api, toast, run, modal, menu, avatar, debounce } from './ui.js';
import { state, isStaff, isSuper, loadMeta } from './store.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderDevices } from './pages/devices.js';
import { renderDevice } from './pages/device.js';
import { renderCatalog } from './pages/catalog.js';
import { renderSettings } from './pages/settings.js';
import { renderUsers } from './pages/users.js';
import { openCreateDevice } from './pages/create.js';
import { renderImport } from './pages/import.js';
import { renderWorkplaces, renderWorkplace } from './pages/workplaces.js';
import { renderNetscan } from './pages/netscan.js';

const app = document.getElementById('app');
let mainEl, sidebarEl, navEl;

// ---------------- Роутер ----------------
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}
export function navigate(path) {
  if (location.hash === '#' + path) route(); else location.hash = path;
}

async function route() {
  if (!state.me) return;
  const { parts, params } = parseHash();
  const [section, sub] = parts;
  highlightNav(section || 'dashboard');
  refreshSidebar();
  mainEl.classList.remove('full');
  window.scrollTo(0, 0);
  document.querySelector('.sidebar')?.classList.remove('open');
  try {
    if (!section) await renderDashboard(mainEl);
    else if (section === 'devices' && sub) await renderDevice(mainEl, Number(sub));
    else if (section === 'devices') await renderDevices(mainEl, params);
    else if (section === 'workplaces' && sub) await renderWorkplace(mainEl, Number(sub));
    else if (section === 'workplaces') await renderWorkplaces(mainEl);
    else if (section === 'import' && isStaff()) await renderImport(mainEl);
    else if (section === 'netscan' && isStaff()) await renderNetscan(mainEl);
    else if (section === 'catalog' && isStaff()) await renderCatalog(mainEl, sub);
    else if (section === 'settings' && isStaff()) await renderSettings(mainEl, sub);
    else if (section === 'users' && isSuper()) await renderUsers(mainEl);
    else clear(mainEl, h('div.empty-state', h('h3', 'Страница не найдена'), h('a', { href: '#/' }, 'На главную')));
  } catch (e) {
    clear(mainEl, h('div.empty-state', h('h3', 'Не удалось загрузить страницу'), h('p', e.message)));
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('itdb:unauthorized', () => { state.me = null; renderLogin(); });
window.addEventListener('itdb:changed', () => refreshSidebar());

// ---------------- Вход ----------------
// Вход выполняется на главной странице портала
function renderLogin() {
  location.href = '/login?next=' + encodeURIComponent('/inventory/' + location.hash);
}

// ---------------- Каркас ----------------
function renderShell() {
  const me = state.me;
  const links = [
    ['dashboard', '#/', 'Панель'],
    ['devices', '#/devices', 'Техника'],
    ['workplaces', '#/workplaces', 'Рабочие места'],
    isStaff() && ['netscan', '#/netscan', 'Сканирование сети'],
    isStaff() && ['import', '#/import', 'Импорт'],
    isStaff() && ['catalog', '#/catalog', 'Справочники'],
    isStaff() && ['settings', '#/settings', 'Настройки'],
    isSuper() && ['users', '#/users', 'Пользователи'],
  ].filter(Boolean);
  navEl = h('nav.topnav.row', { style: { gap: '2px' } },
    links.map(([k, href, label]) => h('a', { href, 'data-k': k }, label)));

  const gsearch = h('input', { type: 'search', placeholder: 'Поиск техники' });
  gsearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { navigate('/devices?q=' + encodeURIComponent(gsearch.value.trim())); gsearch.value = ''; gsearch.blur(); }
  });

  const userName = h('span', { style: { color: 'var(--n500)', fontWeight: 500, marginRight: '4px', whiteSpace: 'nowrap' } }, me.full_name || me.username);
  const avatarBtn = avatar(me.full_name || me.username);
  const bellHost = h('span');
  import('/shared/bell.js').then((m) => m.mountBell(bellHost)).catch(() => {});
  avatarBtn.addEventListener('click', () => menu(avatarBtn, [
    { head: (me.full_name || me.username) + ' · ' + ROLE_LABEL[me.role] },
    { head: 'Разделы' },
    ...portalSections().map(([href, label]) => ({ label, onClick: () => { location.href = href; } })),
    '-',
    { label: 'Сменить пароль', icon: 'lock', onClick: changePassword },
    { label: 'Настройки уведомлений', onClick: notifySettings },
    '-',
    { label: 'Выйти', onClick: async () => { await api.post(location.origin + '/api/auth/logout'); location.href = '/login'; } },
  ], { align: 'right' }));

  const topbar = h('header.topbar',
    h('button.btn.subtle.icon.burger', { onclick: () => sidebarEl.classList.toggle('open'), title: 'Меню' }, icon('menu')),
    h('a.brand', { href: '/', title: 'На главную страницу портала' }, h('span.brand-logo', 'IT'), h('span', 'Портал')),
    h('a.brand', { href: '#/', style: { marginLeft: '-4px' } }, h('span.muted', '/'), h('span', 'ИТ Инвентарь')),
    navEl,
    isStaff() ? h('button.btn.primary', { style: { marginLeft: '8px' }, onclick: () => openCreateDevice() }, icon('plus'), 'Создать') : null,
    h('div.search-global', icon('search'), gsearch),
    h('span', { style: { width: '8px' } }),
    bellHost,
    userName,
    avatarBtn);

  sidebarEl = h('aside.sidebar');
  mainEl = h('main.main');
  clear(app, topbar, h('div.layout', sidebarEl, mainEl));
}

/** Настройки уведомлений: галочка сохраняется сразу */
async function notifySettings() {
  const { getNotifications, setNotifySetting } = await import('/shared/bell.js');
  const d = await getNotifications();
  const cb = h('input', { type: 'checkbox', checked: d.prefs.printer_supplies });
  cb.addEventListener('change', () => run(async () => {
    await setNotifySetting('printer_supplies', cb.checked);
    toast(cb.checked ? 'Уведомления о расходниках включены' : 'Уведомления о расходниках выключены');
  }));
  const m = modal({
    title: 'Настройки уведомлений', size: 'narrow',
    body: h('div.stack', { style: { gap: '10px' } },
      h('label.check', cb, 'Уведомлять о заканчивающихся расходниках принтеров и МФУ'),
      h('p.hint', `Колокольчик в шапке покажет принтеры и МФУ, где тонера или других расходников осталось не больше ${d.threshold ?? 15}%. `
        + 'Принтеры проверяются по сети раз в 2 часа.')),
    footer: [h('button.btn.primary', { onclick: () => m.close() }, 'Готово')],
  });
}

export const ROLE_LABEL = { superadmin: 'Суперадмин', editor: 'Редактор', reader: 'Читатель' };

function highlightNav(section) {
  navEl.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.k === section));
}

// ---------------- Боковая панель ----------------
const refreshSidebar = debounce(async () => {
  if (!sidebarEl) return;
  let stats = { byType: [] }, filters = [];
  try {
    [stats, filters] = await Promise.all([api.get('/api/devices/stats'), api.get('/api/filters')]);
  } catch { /* покажем без чисел */ }
  const counts = {}; let total = 0;
  const statusCounts = {};
  for (const r of stats.byType) {
    counts[r.id] = (counts[r.id] || 0) + r.n; total += r.n;
    statusCounts[r.status] = (statusCounts[r.status] || 0) + r.n;
  }
  const cur = location.hash;
  const link = (href, content, count) => h('a.side-link' + (cur === href ? '.active' : ''), { href }, content,
    count != null ? h('span.count', count) : null);

  clear(sidebarEl,
    h('div.sidebar-project',
      h('div.icon', icon('box', 18)),
      h('div', h('div.name', 'ИТ-служба'), h('div.sub', 'База данных техники'))),
    link('#/', [icon('dashboard'), 'Панель']),
    link('#/devices', [icon('list'), 'Вся техника'], total),
    link('#/workplaces', [icon('users'), 'Рабочие места']),
    h('div.side-section', h('h4', 'Типы техники'),
      state.meta.types.map((t) => link(`#/devices?f=${encodeURIComponent(JSON.stringify({ type: [t.id] }))}`,
        [h('span.type-dot', { style: { background: t.color } }, t.code.slice(0, 2)), t.name], counts[t.id] || 0))),
    h('div.side-section', h('h4', 'По состоянию'),
      state.meta.statuses.map((st) => link(`#/devices?f=${encodeURIComponent(JSON.stringify({ status: [st.key] }))}`,
        [h('span.type-dot', { style: { background: st.color } }), st.label], statusCounts[st.key] || 0))),
    h('div.side-section', h('h4', 'Сохранённые фильтры'),
      filters.length ? filters.map((f) => {
        const href = savedFilterHref(f.query);
        const x = (f.user_id === state.me.id || isSuper())
          ? h('span.x', { title: 'Удалить фильтр', onclick: (e) => { e.preventDefault(); e.stopPropagation(); deleteFilter(f); } }, icon('close', 12))
          : null;
        return h('a.side-link' + (cur === href ? '.active' : ''), { href },
          icon('star'), h('span.grow', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
          f.is_shared ? h('span.lozenge.blue', { title: 'Общий фильтр' }, 'общ') : null, x);
      }) : h('div.muted.small', { style: { padding: '0 8px' } }, 'Настройте фильтры в списке техники и нажмите «Сохранить фильтр»')),
  );
}, 80);

export function savedFilterHref(q) {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.filters && Object.keys(q.filters).length) p.set('f', JSON.stringify(q.filters));
  if (q.sort) p.set('sort', q.sort);
  if (q.dir) p.set('dir', q.dir);
  if (q.cols) p.set('cols', q.cols);
  return '#/devices' + (p.toString() ? '?' + p.toString() : '');
}

async function deleteFilter(f) {
  await run(async () => {
    await api.del('/api/filters/' + f.id);
    toast(`Фильтр «${f.name}» удалён`);
    refreshSidebar();
  });
}

function changePassword() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      if (next.value !== next2.value) throw new Error('Пароли не совпадают');
      await api.post(location.origin + '/api/auth/password', { current: cur.value, next: next.value });
      m.close(); toast('Пароль изменён');
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: 'Смена пароля', size: 'narrow',
    body: h('div.stack', { style: { gap: '12px' } },
      h('label.field', h('span', 'Текущий пароль'), cur),
      h('label.field', h('span', 'Новый пароль (не короче 8 символов)'), next),
      h('label.field', h('span', 'Повторите новый пароль'), next2)),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ---------------- Запуск ----------------
// Разделы портала для меню пользователя (как в остальных разделах)
let portalMe = null;
function portalSections() {
  const a = portalMe?.access || {};
  return [
    ['/', 'Главная'],
    a.inventory && a.inventory !== 'none' && ['/inventory/', 'ИТ-инвентарь'],
    a.docs && a.docs !== 'none' && ['/docs/', 'Документы'],
    a.calendar && a.calendar !== 'none' && ['/calendar/', 'Задачи'],
    a.helpdesk && a.helpdesk !== 'none' && ['/helpdesk/', 'Заявки'],
    portalMe?.user?.isAdmin && ['/admin', 'Администрирование'],
  ].filter(Boolean);
}

async function boot() {
  portalMe = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    const me = await api.get('/api/auth/me');
    state.me = me.user; state.perms = me.perms;
  } catch {
    renderLogin();
    return;
  }
  await loadMeta();
  renderShell();
  route();
}
boot();
