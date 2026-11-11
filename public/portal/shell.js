// Общая шапка страниц портала (в стиле ИТ-инвентаря)
import { h, makeApi, modal, run, toast, topbar } from '/shared/ui.js';

export const api = makeApi('', {
  onUnauthorized: () => { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash); },
});

export async function loadMe() {
  return api.get('/api/auth/me');
}

export function helpdeskUrl(me) {
  return me.helpdeskUrl || `${location.protocol}//${location.hostname}:${me.helpdeskPort}/`;
}

/** Разделы портала, доступные пользователю: [key, href, label] */
export function sections(me) {
  return [
    ['home', '/', 'Главная'],
    me.access.inventory !== 'none' && ['inventory', '/inventory/', 'ИТ-инвентарь'],
    me.access.docs !== 'none' && ['docs', '/docs/', 'Документы'],
    me.access.calendar !== 'none' && ['calendar', '/calendar/', 'Задачи'],
    me.access.helpdesk !== 'none' && ['helpdesk', '/helpdesk/', 'Заявки'],
    me.user.isAdmin && ['admin', '/admin', 'Администрирование'],
  ].filter(Boolean);
}

/** Меню пользователя: переход в другие разделы, профиль, выход */
export function userMenu(me) {
  return [
    { head: 'Разделы' },
    ...sections(me).map(([, href, label]) => ({ label, href })),
    '-',
    { label: 'Профиль и пароль', onClick: () => profileDialog(me) },
    { label: 'Выйти', onClick: logout },
  ];
}

/**
 * Шапка раздела. Для главной и администрирования — навигация по разделам портала,
 * для остальных — свой раздел и его страницы.
 */
export function portalTopbar(me, active, opts = {}) {
  // Колокольчик уведомлений — тем, у кого есть доступ к инвентарю (расходники принтеров)
  let right = null;
  if (me.access.inventory !== 'none') {
    right = h('span');
    import('/shared/bell.js').then((m) => m.mountBell(right)).catch(() => {});
  }
  return topbar({
    right,
    section: opts.section, sectionHref: opts.sectionHref,
    nav: opts.nav || sections(me), active,
    actions: opts.actions,
    onBurger: opts.onBurger,
    userName: me.user.full_name || me.user.username,
    userSub: me.user.isAdmin ? 'Администратор' : me.user.username,
    menu: userMenu(me),
  });
}

export async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  location.href = '/login';
}

/** Настройки уведомлений (в профиле): галочка сохраняется сразу */
function notifySettingsBox() {
  const cb = h('input', { type: 'checkbox', disabled: true });
  const box = h('div', h('h3', { style: { marginTop: '8px' } }, 'Уведомления'),
    h('label.check', cb, 'Уведомлять о заканчивающихся расходниках принтеров и МФУ (колокольчик в шапке)'));
  import('/shared/bell.js').then(async (m) => {
    const d = await m.getNotifications();
    cb.checked = d.prefs.printer_supplies; cb.disabled = false;
    cb.addEventListener('change', () => m.setNotifySetting('printer_supplies', cb.checked)
      .then(() => toast(cb.checked ? 'Уведомления о расходниках включены' : 'Уведомления о расходниках выключены'))
      .catch((e) => toast(e.message, 'err')));
  }).catch(() => {});
  return box;
}

export function profileDialog(me) {
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
    body: h('div.stack', { style: { gap: '12px' } },
      h('div.muted', 'Логин: ', h('strong', u.username)),
      h('label.field', h('span', 'ФИО'), fullName),
      h('label.field', h('span', 'E-mail (для уведомлений о заявках)'), email),
      h('h3', { style: { marginTop: '8px' } }, 'Смена пароля'),
      h('p.hint', 'Пароль общий для всех разделов портала. Оставьте поля пустыми, чтобы не менять.'),
      h('label.field', h('span', 'Текущий пароль'), cur),
      h('div.form-grid',
        h('label.field', h('span', 'Новый пароль (от 8 символов)'), next),
        h('label.field', h('span', 'Повторите новый пароль'), next2)),
      me.access.inventory !== 'none' ? notifySettingsBox() : null),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}
