// Удалённый доступ: кнопка «Подключиться» для карточки техники, заявки и страницы «Удалённый доступ».
// Подключение: портал выдаёт одноразовую ссылку itremote://…, браузер передаёт её программе специалиста
// (ITRemoteViewer), и та открывается с уже подставленными параметрами.
import { h, clear, makeApi, modal, toast, run, relTime } from './ui.js';

const api = makeApi('/remote/api');
let mePromise = null;

/** Права текущего пользователя на удалённый доступ (null — нет доступа) */
export function remoteMe() {
  if (!mePromise) mePromise = api.get('/remote/api/me').catch(() => null);
  return mePromise;
}

/** Передать ссылку программе специалиста и подсказать, если программа не открылась */
export function launchViewer(url, computerName) {
  let opened = false;
  const onBlur = () => { opened = true; setTimeout(() => m.close(), 300); };
  window.addEventListener('blur', onBlur);
  const copy = h('button.btn.subtle', {
    onclick: () => {
      navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована — вставьте её в программе: «Новое подключение»'),
        () => toast('Не удалось скопировать', 'err'));
    },
  }, 'Скопировать ссылку');
  const m = modal({
    title: 'Подключение к ' + computerName,
    narrow: true,
    body: h('div.stack', { style: { gap: '10px' } },
      h('p', 'Открываем программу «ИТ Удалённый доступ»… Если браузер спросит, разрешите открыть приложение.'),
      h('p.muted.small', 'Ничего не открылось? Установите программу специалиста — ',
        h('a', { href: '/remote/#/install' }, 'страница «Установка»'),
        '. Ссылка действует около минуты и только один раз.')),
    footer: [copy, h('button.btn', { onclick: () => m.close() }, 'Закрыть')],
    onClose: () => window.removeEventListener('blur', onBlur),
  });
  // Переход по ссылке с нестандартным протоколом не уходит со страницы
  location.href = url;
  setTimeout(() => { if (opened) m.close(); }, 15000);
}

/** Начать подключение: opts = { deviceId | agentId, mode: 'control'|'view', ticketId?, silent? } */
export async function connect(opts, btn) {
  return run(async () => {
    const r = await api.post('/remote/api/sessions', opts);
    launchViewer(r.url, r.computerName);
  }, btn);
}

export async function wake(deviceId, btn) {
  return run(async () => {
    await api.post('/remote/api/wake', { deviceId });
    toast('Сигнал включения отправлен. Компьютер появится в сети через 1–2 минуты, если он поддерживает Wake-on-LAN.');
  }, btn);
}

/** Кнопки подключения к агенту (строка таблицы, карточка) */
export function connectButtons(agent, me, extra = {}, small = false) {
  const sz = small ? '.sm' : '';
  const target = agent.id ? { agentId: agent.id } : { deviceId: agent.device_id };
  const btns = [];
  if (me.canControl) {
    const b = h('button.btn.primary' + sz, {
      disabled: !agent.online, title: agent.online ? 'Управлять компьютером' : 'Компьютер не в сети',
      onclick: () => connect({ ...target, ...extra, mode: 'control' }, b),
    }, 'Подключиться');
    btns.push(b);
  }
  const v = h('button.btn' + sz + (me.canControl ? '' : '.primary'), {
    disabled: !agent.online, title: 'Только смотреть экран, без управления',
    onclick: () => connect({ ...target, ...extra, mode: 'view' }, v),
  }, me.canControl ? 'Только просмотр' : 'Посмотреть экран');
  btns.push(v);
  if (me.allowSilent) {
    const s = h('button.btn.subtle' + sz, {
      disabled: !agent.online, title: 'Подключиться без запроса и уведомления пользователя (записывается в журнал)',
      onclick: () => connect({ ...target, ...extra, mode: 'control', silent: true }, s),
    }, 'Без уведомления');
    btns.push(s);
  }
  return btns;
}

export function onlineBadge(agent) {
  return agent.online
    ? h('span.lozenge.green', { title: 'Агент отвечает' }, 'в сети')
    : h('span.lozenge', { title: 'Последняя связь: ' + new Date(agent.last_seen).toLocaleString('ru-RU') }, 'не в сети');
}

/**
 * Блок «Удалённый доступ» для карточки техники или заявки.
 * Возвращает элемент сразу; содержимое подгружается. Если у пользователя нет доступа — элемент пустой и скрыт.
 * hideIfMissing — не показывать «агент не установлен» (для принтеров и прочей техники); onShow — блок стал видимым.
 */
export function remotePanel(deviceId, { ticketId, title = true, hideIfMissing = false, onShow } = {}) {
  const box = h('div.remote-panel', { style: { display: 'none' } });
  (async () => {
    const me = await remoteMe();
    if (!me || !deviceId) return;
    const agents = await api.get('/remote/api/agents?device=' + deviceId).catch(() => []);
    if (!agents.length && hideIfMissing) return;
    box.style.display = '';
    if (onShow) onShow();
    const head = title ? h('div.remote-head', h('strong', 'Удалённый доступ')) : null;
    if (!agents.length) {
      clear(box, head, h('div.muted.small', 'Агент удалённого доступа на этом компьютере не установлен.',
        me.isAdmin ? [' ', h('a', { href: '/remote/#/install' }, 'Как установить')] : null));
      return;
    }
    const a = agents[0];
    const info = a.online
      ? (a.windows_user ? 'Пользователь: ' + a.windows_user : 'В систему никто не вошёл')
      : 'Последняя связь ' + relTime(a.last_seen);
    const extra = ticketId ? { ticketId } : {};
    clear(box, head,
      h('div.row', { style: { flexWrap: 'wrap', gap: '6px' } }, onlineBadge(a), h('span.muted.small', info)),
      h('div.row', { style: { flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
        connectButtons(a, me, extra),
        a.online ? null : h('button.btn', { title: 'Отправить сигнал Wake-on-LAN', onclick: (e) => wake(deviceId, e.currentTarget) }, 'Разбудить')));
  })();
  return box;
}
