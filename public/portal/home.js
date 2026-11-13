// Главная страница портала: сводка «моё» (заявки, задачи на сегодня, уведомления) и плитки разделов
import { h, clear, statusPill } from '/shared/ui.js';
import { api, loadMe, portalTopbar, helpdeskUrl } from './shell.js';

const ICONS = {
  inventory: '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H6a2 2 0 0 1-2-2zm2 0v9h12V5z"/></svg>',
  docs: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5zM8 12v2h8v-2zm0 4v2h8v-2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM5 9v10h14V9zm2 2h4v4H7z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 17a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm1.6-6.1c-.8.5-1 .8-1 1.6h-2c0-1.6.6-2.4 1.8-3.1.8-.5 1.1-.9 1.1-1.6 0-.8-.6-1.4-1.5-1.4s-1.6.6-1.6 1.6h-2c0-2 1.5-3.5 3.6-3.5s3.5 1.3 3.5 3.2c0 1.4-.7 2.4-1.9 3.2z"/></svg>',
  helpdesk: '<svg viewBox="0 0 24 24"><path d="M12 2a8 8 0 0 0-8 8v4a3 3 0 0 0 3 3h1v-7H6a6 6 0 0 1 12 0h-2v7h2v1a2 2 0 0 1-2 2h-3a1 1 0 1 0 0 2h3a4 4 0 0 0 4-4v-1.2A3 3 0 0 0 20 14v-4a8 8 0 0 0-8-8z"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.5-8 11-4.6-1.5-8-6-8-11V5zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-4.5 9.5c1 1.3 2.6 2.4 4.5 3 1.9-.6 3.5-1.7 4.5-3-1-1-2.7-1.6-4.5-1.6s-3.5.6-4.5 1.6z"/></svg>',
};

const LEVEL = {
  view: 'просмотр', edit: 'редактирование', admin: 'администратор', executor: 'исполнитель',
};

// Старые закладки ИТ-инвентаря (http://сервер:3000/#/devices/5) ведут теперь в /inventory/
// (кроме случая «нет доступа к инвентарю» — иначе страница перезагружалась бы по кругу)
if (/^#\/(devices|workplaces|catalog|settings|users|import)/.test(location.hash) && !/[?&]denied=/.test(location.search)) {
  location.replace('/inventory/' + location.hash);
}

async function main() {
  const app = document.getElementById('app');
  const me = await loadMe();
  const [summary, my] = await Promise.all([api.get('/api/summary').catch(() => ({})), api.get('/api/summary/my').catch(() => ({}))]);
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
      text: 'Планирование работ службы ИТ: календарь, исполнители, чек-листы, сроки.',
      stats: s.calendar && [stat(s.calendar.mine, 'мои открытые'), stat(s.calendar.today, 'на сегодня')],
    },
    a.helpdesk !== 'none' && {
      key: 'helpdesk', href: '/helpdesk/', title: 'Заявки (Helpdesk)', color: '#FF8B00',
      text: 'Заявки сотрудников предприятия в службу ИТ: назначение исполнителей, сроки, статусы.',
      stats: s.helpdesk && [stat(s.helpdesk.open, 'открыто'), stat(s.helpdesk.mine, 'на мне'),
        stat(s.helpdesk.unassigned, 'без исполнителя', true), stat(s.helpdesk.overdue, 'просрочено', true)],
    },
    me.user.isAdmin && {
      key: 'admin', href: '/admin', title: 'Администрирование', color: '#5E6C84',
      text: 'Пользователи портала и права: что каждый сотрудник может просматривать и редактировать.',
    },
    {
      key: 'help', href: '/help', title: 'Инструкция', color: '#00A3BF',
      text: 'Пошаговые инструкции по разделам и возможностям, доступным вам.',
    },
  ].filter(Boolean);

  const deniedLabel = { inventory: 'ИТ-инвентарь', docs: 'Документы', calendar: 'Задачи и календарь', helpdesk: 'Заявки', admin: 'Администрирование' }[params.get('denied')];
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  const LZ = { view: '', edit: '.green', admin: '.purple', executor: '.blue' };
  clear(app,
    portalTopbar(me, 'home'),
    h('div.layout', h('main.main.full', h('div.page',
      deniedLabel ? h('div.error-box', { style: { marginBottom: '16px' } }, `Нет доступа к разделу «${deniedLabel}». Обратитесь к администратору портала.`) : null,
      h('div.breadcrumbs', h('span', 'ИТ-портал')),
      h('div.page-head', h('div',
        h('h1', `${greet}, ${(me.user.full_name || me.user.username).split(' ').slice(-2).join(' ')}`),
        h('div.muted', { style: { marginTop: '4px' } }, 'Сегодня ' + new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }),
          h('span', { 'data-brand-company': '', 'data-sep': ' · ' })))),
      firstTip(),
      myBoard(my),
      h('h2.home-sec', 'Разделы'),
      tiles.length
        ? h('div.tiles', tiles.map((t) => h('a.tile', { href: t.href, style: { '--tile': t.color } },
          h('div.tile-icon', { html: ICONS[t.key] }),
          h('div.tile-body',
            h('div.tile-title', t.title),
            a[t.key] ? h('div.tile-level', h('span.lozenge' + (LZ[a[t.key]] || ''), LEVEL[a[t.key]] || '')) : null,
            h('p', t.text),
            t.stats ? h('div.stats', t.stats) : null))))
        : h('div.empty-state', h('h3', 'Нет доступных разделов'), 'Обратитесь к администратору портала.'),
      h('div.panel.hd-banner',
        h('div', h('strong', 'Сайт заявок для сотрудников предприятия'),
          h('div.muted.small', 'Сотрудники, не входящие в службу ИТ, регистрируются по рабочей почте и оставляют заявки здесь:')),
        h('a.btn', { href: helpdeskUrl(me), target: '_blank', rel: 'noopener' }, helpdeskUrl(me).replace(/^https?:\/\//, '')))))));
}

// Подсказка при первом входе (запоминается в браузере)
function firstTip() {
  let seen = false;
  try { seen = localStorage.getItem('portal.tipSeen') === '1'; } catch { /* нет хранилища */ }
  if (seen) return null;
  const box = h('div.panel.first-tip',
    h('div', { style: { fontSize: '28px' } }, '👋'),
    h('div.grow', h('b', 'Коротко о портале. '),
      'Справа в шапке: 🔍 поиск по всему порталу (Ctrl+K), ☆ избранное и недавнее, 🔔 уведомления. ',
      'Наведите мышь на номер заявки или ключ техники — появится краткая карточка. Тёмная тема и компактный вид — в меню с вашим именем.'),
    h('a.btn', { href: '/help' }, 'Инструкция'),
    h('button.btn.primary', { onclick: () => { try { localStorage.setItem('portal.tipSeen', '1'); } catch { /* */ } box.remove(); } }, 'Понятно'));
  return box;
}

// ---------------- Сводка «моё» ----------------
const PRIO = { critical: 'критический', high: 'высокий' };
const fmtDue = (v) => new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = (t) => (t.all_day ? 'весь день' : new Date(t.start_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));

function card(title, href, count, body, extra) {
  return h('section.home-card',
    h('div.home-card-head', h('h3', title, count != null ? h('span.badge', String(count)) : null), h('span.spacer'),
      extra || null, href ? h('a.small', { href }, 'Открыть →') : null),
    h('div.home-card-body', body));
}

function myBoard(my) {
  const cards = [];
  if (my.tickets) {
    const list = my.tickets;
    cards.push(card('Мои заявки', '/helpdesk/#/?view=mine', list.length, list.length
      ? list.slice(0, 8).map((t) => h('a.home-row' + (t.overdue ? '.over' : ''), { href: `/helpdesk/#/tickets/${t.id}` },
        h('div.home-row-main', h('b', `#${t.id} ${t.title}`),
          h('div.small.muted', [t.requester, PRIO[t.priority] ? `приоритет ${PRIO[t.priority]}` : ''].filter(Boolean).join(' · '))),
        h('div.home-row-side', statusPill(t.status, t.status_color),
          t.due_at ? h('div.small' + (t.overdue ? '.over-text' : '.muted'), (t.overdue ? 'просрочена: ' : 'срок ') + fmtDue(t.due_at)) : null)))
        .concat(list.length > 8 ? [h('a.home-more', { href: '/helpdesk/#/?view=mine' }, `и ещё ${list.length - 8}`)] : [])
      : h('div.home-empty', 'Открытых заявок на вас нет.')));
  }
  if (my.tasks) {
    const list = my.tasks;
    const over = list.filter((t) => t.overdue).length;
    cards.push(card('Мои задачи на сегодня', '/calendar/', list.length, list.length
      ? list.slice(0, 8).map((t) => h('a.home-row' + (t.overdue ? '.over' : ''), { href: `/calendar/#/calendar?task=${t.id}` },
        h('div.home-row-main', h('b', t.title),
          h('div.small.muted', [t.category, t.status === 'in_progress' ? 'в работе' : ''].filter(Boolean).join(' · '))),
        h('div.home-row-side.small' + (t.overdue ? '.over-text' : '.muted'),
          t.overdue ? 'просрочена' : fmtTime(t))))
        .concat(list.length > 8 ? [h('a.home-more', { href: '/calendar/' }, `и ещё ${list.length - 8}`)] : [])
      : h('div.home-empty', 'На сегодня задач нет.'), over ? h('span.lozenge.red', `просрочено: ${over}`) : null));
  }
  const notes = h('div.home-card-body', h('div.home-empty', 'Загрузка…'));
  const notesCard = h('section.home-card',
    h('div.home-card-head', h('h3', 'Уведомления'), h('span.spacer'),
      h('a.small', { href: '#', onclick: (e) => { e.preventDefault(); import('/shared/bell.js').then((m) => m.openNotifySettings()); } }, 'Настройки')),
    notes);
  cards.push(notesCard);
  const loadNotes = async () => {
    try {
      const m = await import('/shared/bell.js');
      const d = await m.getNotifications();
      const items = [...d.events.filter((x) => !x.read), ...d.states];
      clear(notes, items.length ? items.slice(0, 10).map((x) => m.itemEl(x)) : h('div.home-empty', 'Новых уведомлений нет.'),
        items.length > 10 ? h('div.home-more', `и ещё ${items.length - 10} — в колокольчике вверху`) : null,
        d.events.some((x) => !x.read) ? h('button.btn.sm.subtle', { style: { margin: '8px 12px' }, onclick: async () => { await m.markRead('all'); loadNotes(); document.dispatchEvent(new CustomEvent('nb-changed')); } }, 'Отметить все прочитанными') : null);
    } catch (e) { clear(notes, h('div.home-empty', e.message)); }
  };
  loadNotes();
  document.addEventListener('nb-changed', loadNotes);
  return h('div.home-board', { style: { gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` } }, cards);
}

main().catch((e) => {
  document.getElementById('app').textContent = 'Ошибка загрузки: ' + e.message;
});
