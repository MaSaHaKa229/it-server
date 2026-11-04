// Главная страница портала: плитки разделов, доступных пользователю
import { h, clear } from '/shared/ui.js';
import { api, loadMe, topbar, helpdeskUrl } from './shell.js';

const ICONS = {
  inventory: '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H6a2 2 0 0 1-2-2zm2 0v9h12V5z"/></svg>',
  docs: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5zM8 12v2h8v-2zm0 4v2h8v-2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM5 9v10h14V9zm2 2h4v4H7z"/></svg>',
  helpdesk: '<svg viewBox="0 0 24 24"><path d="M12 2a8 8 0 0 0-8 8v4a3 3 0 0 0 3 3h1v-7H6a6 6 0 0 1 12 0h-2v7h2v1a2 2 0 0 1-2 2h-3a1 1 0 1 0 0 2h3a4 4 0 0 0 4-4v-1.2A3 3 0 0 0 20 14v-4a8 8 0 0 0-8-8z"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.5-8 11-4.6-1.5-8-6-8-11V5zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-4.5 9.5c1 1.3 2.6 2.4 4.5 3 1.9-.6 3.5-1.7 4.5-3-1-1-2.7-1.6-4.5-1.6s-3.5.6-4.5 1.6z"/></svg>',
};

const LEVEL = {
  view: 'просмотр', edit: 'редактирование', admin: 'администратор', executor: 'исполнитель',
};

// Старые закладки ИТ-инвентаря (http://сервер:3000/#/devices/5) ведут теперь в /inventory/
if (/^#\/(devices|catalog|settings|users|import)/.test(location.hash)) location.replace('/inventory/' + location.hash);

async function main() {
  const app = document.getElementById('app');
  const me = await loadMe();
  const summary = await api.get('/api/summary').catch(() => ({}));
  const a = me.access;
  const s = summary;
  const params = new URLSearchParams(location.search);

  const stat = (n, label, warn) => (n == null ? null : h('div.stat' + (warn && n ? '.warn' : ''), h('b', String(n)), h('span', label)));

  const tiles = [
    a.inventory !== 'none' && {
      key: 'inventory', href: '/inventory/', title: 'ИТ-инвентарь', color: '#0052CC',
      text: 'Компьютеры, принтеры, серверы и другая техника: характеристики, ПО, пароли, история.',
      stats: s.inventory && [stat(s.inventory.total, 'единиц техники'), stat(s.inventory.broken, 'сломано', true)],
    },
    a.docs !== 'none' && {
      key: 'docs', href: '/docs/', title: 'Документы', color: '#6554C0',
      text: 'Реестр законов, ГОСТов, приказов и регламентов с полнотекстовым поиском.',
      stats: s.docs && [stat(s.docs.total, 'документов'), stat(s.docs.recent, 'изменено за неделю')],
    },
    a.calendar !== 'none' && {
      key: 'calendar', href: '/calendar/', title: 'Задачи и календарь', color: '#00875A',
      text: 'Планирование работ отдела: календарь, исполнители, чек-листы, сроки.',
      stats: s.calendar && [stat(s.calendar.mine, 'мои открытые'), stat(s.calendar.today, 'на сегодня')],
    },
    a.helpdesk !== 'none' && {
      key: 'helpdesk', href: '/helpdesk/', title: 'Заявки (Helpdesk)', color: '#FF8B00',
      text: 'Заявки сотрудников предприятия в ИТ-отдел: назначение исполнителей, сроки, статусы.',
      stats: s.helpdesk && [stat(s.helpdesk.open, 'открыто'), stat(s.helpdesk.mine, 'на мне'),
        stat(s.helpdesk.unassigned, 'без исполнителя', true), stat(s.helpdesk.overdue, 'просрочено', true)],
    },
    me.user.isAdmin && {
      key: 'admin', href: '/admin', title: 'Администрирование', color: '#5E6C84',
      text: 'Пользователи портала и права: что каждый сотрудник может просматривать и редактировать.',
    },
  ].filter(Boolean);

  const deniedLabel = { inventory: 'ИТ-инвентарь', docs: 'Документы', calendar: 'Задачи и календарь', helpdesk: 'Заявки', admin: 'Администрирование' }[params.get('denied')];
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  clear(app,
    topbar(me, 'home'),
    h('main.page',
      deniedLabel ? h('div.error-box', { style: { marginBottom: '16px' } }, `Нет доступа к разделу «${deniedLabel}». Обратитесь к администратору портала.`) : null,
      h('div.page-head', h('div',
        h('h1', `${greet}, ${(me.user.full_name || me.user.username).split(' ').slice(-2).join(' ')}`),
        h('div.muted', 'Выберите раздел'))),
      tiles.length
        ? h('div.tiles', tiles.map((t) => h('a.tile', { href: t.href, style: { '--tile': t.color } },
          h('div.tile-icon', { html: ICONS[t.key] }),
          h('div.tile-body',
            h('div.tile-title', t.title),
            a[t.key] ? h('div.tile-level', LEVEL[a[t.key]] || '') : null,
            h('p', t.text),
            t.stats ? h('div.stats', t.stats) : null))))
        : h('div.card.empty', 'Вам пока не открыт ни один раздел. Обратитесь к администратору портала.'),
      h('div.card.hd-card',
        h('div', h('strong', 'Сайт заявок для сотрудников предприятия'),
          h('div.muted.small', 'Сотрудники, не входящие в ИТ-отдел, регистрируются по рабочей почте и оставляют заявки здесь:')),
        h('a.btn', { href: helpdeskUrl(me), target: '_blank', rel: 'noopener' }, helpdeskUrl(me).replace(/^https?:\/\//, '')))));
}

main().catch((e) => {
  document.getElementById('app').textContent = 'Ошибка загрузки: ' + e.message;
});
