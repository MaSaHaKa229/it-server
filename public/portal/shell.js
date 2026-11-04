// Общая шапка страниц портала
import { h, makeApi, modal, run, toast, avatar } from '/shared/ui.js';

export const api = makeApi('', {
  onUnauthorized: () => { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash); },
});

export async function loadMe() {
  return api.get('/api/auth/me');
}

export function helpdeskUrl(me) {
  return me.helpdeskUrl || `${location.protocol}//${location.hostname}:${me.helpdeskPort}/`;
}

export function topbar(me, active) {
  const u = me.user;
  const name = u.full_name || u.username;
  const menu = h('div.user-menu.hidden',
    h('div.user-menu-head', h('strong', name), h('div.muted.small', u.isAdmin ? 'Администратор портала' : u.username)),
    h('button.menu-item', { onclick: () => profileDialog(me) }, 'Профиль и пароль'),
    h('button.menu-item', { onclick: logout }, 'Выйти'));
  const btn = h('button.avatar-btn', { title: name, onclick: (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); } }, avatar(name));
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.add('hidden'); });

  const links = [
    ['home', '/', 'Главная'],
    me.access.inventory !== 'none' && ['inventory', '/inventory/', 'ИТ-инвентарь'],
    me.access.docs !== 'none' && ['docs', '/docs/', 'Документы'],
    me.access.calendar !== 'none' && ['calendar', '/calendar/', 'Задачи'],
    me.access.helpdesk !== 'none' && ['helpdesk', '/helpdesk/', 'Заявки'],
    u.isAdmin && ['admin', '/admin', 'Администрирование'],
  ].filter(Boolean);
  return h('header.topbar',
    h('a.brand', { href: '/' }, h('span.brand-logo', 'IT'), h('span.brand-text', 'ИТ-портал')),
    h('nav.topnav', links.map(([k, href, label]) => h('a' + (k === active ? '.active' : ''), { href }, label))),
    h('span.spacer'),
    h('div.user-wrap', btn, menu));
}

async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  location.href = '/login';
}

function profileDialog(me) {
  const u = me.user;
  const fullName = h('input', { type: 'text', value: u.full_name || '' });
  const email = h('input', { type: 'email', value: u.email || '' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      await api.patch('/api/auth/me', { full_name: fullName.value, email: email.value });
      if (next.value || cur.value) {
        if (next.value !== next2.value) throw new Error('Новые пароли не совпадают');
        await api.post('/api/auth/password', { current: cur.value, next: next.value });
      }
      m.close();
      toast('Сохранено');
      setTimeout(() => location.reload(), 600);
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: 'Профиль',
    body: h('div.stack',
      h('div.muted', 'Логин: ', h('strong', u.username)),
      h('label.field', h('span', 'ФИО'), fullName),
      h('label.field', h('span', 'E-mail (для уведомлений о заявках)'), email),
      h('h3', { style: { marginTop: '8px' } }, 'Смена пароля'),
      h('p.hint', 'Пароль общий для всех разделов портала. Оставьте поля пустыми, чтобы не менять.'),
      h('label.field', h('span', 'Текущий пароль'), cur),
      h('div.grid2',
        h('label.field', h('span', 'Новый пароль (от 8 символов)'), next),
        h('label.field', h('span', 'Повторите новый пароль'), next2))),
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), save],
  });
}
