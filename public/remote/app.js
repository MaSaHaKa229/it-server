// Удалённый доступ: компьютеры с агентом, журнал подключений, установка, настройки
import { h, clear, makeApi, modal, run, toast, confirmDialog, fmtDateTime, relTime, fmtSize, parseHash, sortHead, sortRows, savedSort } from '/shared/ui.js';
import { loadMe, portalTopbar } from '/portal/shell.js';
import { remoteMe, connectButtons, onlineBadge, wake } from '/shared/remote.js';

const api = makeApi('/remote/api', {
  onUnauthorized: () => { location.href = '/login?next=' + encodeURIComponent('/remote/' + location.hash); },
});

let me, rme, main;

const STATUS = {
  issued: ['ссылка выдана', ''],
  opened: ['подключается', '.blue'],
  started: ['идёт', '.green'],
  ended: ['завершён', ''],
  denied: ['отклонил пользователь', '.red'],
  no_answer: ['нет ответа пользователя', '.yellow'],
  failed: ['ошибка', '.red'],
  expired: ['не подключился', ''],
};

async function boot() {
  me = await loadMe();
  rme = await remoteMe();
  const app = document.getElementById('app');
  main = h('div.page');
  clear(app, portalTopbar(me, 'remote'), h('div.layout', h('main.main.full', main)));
  window.addEventListener('hashchange', route);
  route();
}

function tabs(active) {
  const items = [
    ['', 'Компьютеры'],
    ['journal', rme.isAdmin ? 'Журнал подключений' : 'Мои подключения'],
    ['install', 'Установка'],
    rme.isAdmin && ['settings', 'Настройки'],
  ].filter(Boolean);
  return h('div.tabs', items.map(([k, label]) => h('a.tab' + (k === active ? '.active' : ''), { href: '#/' + k }, label)));
}

function page(active, ...content) {
  clear(main,
    h('div.breadcrumbs', h('a', { href: '/' }, 'ИТ-портал'), h('span.sep', '/'), h('span', 'Удалённый доступ')),
    h('div.page-head', h('div',
      h('h1', 'Удалённый доступ'),
      h('div.muted', { style: { marginTop: '4px' } },
        'Подключение к компьютерам пользователей. Пользователь продолжает работать и видит всё, что делает специалист.'))),
    tabs(active), ...content);
}

async function route() {
  const { parts } = parseHash();
  try {
    if (parts[0] === 'journal') await renderJournal();
    else if (parts[0] === 'install') await renderInstall();
    else if (parts[0] === 'settings' && rme.isAdmin) await renderSettings();
    else await renderAgents();
  } catch (e) {
    clear(main, h('div.error-box', e.message));
  }
}

// ---------------- Компьютеры ----------------
const agentSort = savedSort('remote-agents', { key: 'online', dir: -1 });
let agentFilter = { q: '', unbound: false };

async function renderAgents() {
  const q = h('input', { type: 'search', placeholder: 'Имя компьютера, пользователь, IP, инв. номер', value: agentFilter.q, style: { width: '340px' } });
  const unbound = h('input', { type: 'checkbox', checked: agentFilter.unbound });
  const box = h('div');
  const count = h('span.muted.small');
  page('',
    h('div.row', { style: { margin: '8px 0 12px', flexWrap: 'wrap' } }, q,
      rme.isAdmin ? h('label.check', unbound, 'Не привязанные к технике') : null, h('span.spacer'), count),
    box);

  const cols = [
    { key: 'online', label: '', value: (a) => (a.online ? 1 : 0) },
    { key: 'computer_name', label: 'Компьютер' },
    { key: 'windows_user', label: 'Пользователь Windows' },
    { key: 'device', label: 'Техника в инвентаре', value: (a) => a.device_key || '' },
    { key: 'ip', label: 'IP-адрес', value: (a) => (a.ips || [])[0] || a.seen_ip || '' },
    { key: 'last_seen', label: 'Связь', value: (a) => new Date(a.last_seen).getTime() },
    { key: 'version', label: 'Агент' },
    { label: '', sortable: false },
  ];
  let rows = [];
  const draw = () => {
    const sorted = sortRows(rows, cols, agentSort);
    count.textContent = `Компьютеров: ${rows.length}, в сети: ${rows.filter((a) => a.online).length}`;
    if (!rows.length) {
      clear(box, h('div.empty-state', h('h3', agentFilter.q || agentFilter.unbound ? 'Ничего не найдено' : 'Агенты ещё не установлены'),
        agentFilter.q || agentFilter.unbound ? null : h('p', 'Установите агент на компьютеры пользователей — см. вкладку ', h('a', { href: '#/install' }, '«Установка»'), '.')));
      return;
    }
    clear(box, h('div.table-wrap', h('table.list',
      sortHead(cols, agentSort, draw),
      h('tbody', sorted.map((a) => h('tr',
        h('td', onlineBadge(a)),
        h('td', { title: a.os || '' }, h('strong', a.computer_name), h('div.muted.small', a.os || '')),
        h('td', a.windows_user || h('span.muted', a.online ? 'никто не вошёл' : '—')),
        h('td', a.device_id
          ? h('a', { href: '/inventory/#/devices/' + a.device_id }, `${a.device_key} · ${a.device_hostname || a.device_inv || ''}`)
          : h('span.muted', 'не привязан'),
        a.device_employee ? h('div.muted.small', a.device_employee) : null),
        h('td', (a.ips || [])[0] || a.seen_ip || ''),
        h('td', { title: fmtDateTime(a.last_seen) }, a.online ? 'сейчас' : relTime(a.last_seen)),
        h('td.muted.small', a.version || ''),
        h('td', h('div.row', { style: { gap: '4px', justifyContent: 'flex-end' } },
          connectButtons(a, rme, {}, true),
          !a.online && a.device_id ? h('button.btn.sm', { title: 'Wake-on-LAN', onclick: (e) => wake(a.device_id, e.currentTarget) }, 'Разбудить') : null,
          rme.isAdmin ? h('button.btn.sm.subtle', { title: 'Привязка к технике, удаление', onclick: () => agentDialog(a, load) }, '⋯') : null))))))));
  };
  const load = async () => {
    const p = new URLSearchParams();
    if (agentFilter.q) p.set('q', agentFilter.q);
    if (agentFilter.unbound) p.set('unbound', '1');
    rows = await api.get('/remote/api/agents?' + p);
    draw();
  };
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { agentFilter.q = q.value.trim(); load(); }, 250); });
  unbound.addEventListener('change', () => { agentFilter.unbound = unbound.checked; load(); });
  await load();
}

function agentDialog(a, reload) {
  const q = h('input', { type: 'search', placeholder: 'Сетевое имя, инв. номер, сотрудник', value: a.computer_name.split('.')[0] });
  const list = h('div.stack', { style: { gap: '4px', marginTop: '8px', maxHeight: '320px', overflow: 'auto' } });
  const bind = (deviceId) => run(async () => {
    await api.patch('/remote/api/agents/' + a.id, { deviceId });
    m.close();
    toast(deviceId ? 'Агент привязан к технике' : 'Привязка снята');
    reload();
  });
  let timer;
  const search = async () => {
    const rows = await fetch('/inventory/api/devices?' + new URLSearchParams({ q: q.value, limit: '30' }), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] }));
    const items = Array.isArray(rows) ? rows : rows.items || rows.rows || [];
    clear(list, items.length ? items.slice(0, 30).map((d) => h('button.btn.subtle', {
      style: { justifyContent: 'flex-start', height: 'auto', padding: '6px 8px', textAlign: 'left' },
      onclick: () => bind(d.id),
    }, h('div', h('strong', d.hostname || d.inv_number || ('#' + d.id)),
      h('div.muted.small', [d.type_name, d.model, d.employee, d.location].filter(Boolean).join(' · '))))) : h('p.muted', 'Ничего не найдено'));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  const m = modal({
    title: 'Агент ' + a.computer_name,
    body: h('div.stack', { style: { gap: '10px' } },
      h('div.muted.small', `ID: ${a.id} · установлен ${fmtDateTime(a.registered_at)} · порт ${a.port}`),
      h('div.muted.small', 'Отпечаток сертификата: ', h('code', a.fingerprint || '—')),
      h('h3', 'Привязать к технике из инвентаря'),
      a.device_id ? h('div.row', 'Сейчас: ', h('strong', `${a.device_key} · ${a.device_hostname || ''}`),
        h('button.btn.sm.subtle', { onclick: () => bind(null) }, 'Отвязать')) : null,
      q, list),
    footer: [
      h('button.btn.danger', {
        onclick: async () => {
          if (!await confirmDialog('Удалить агент из списка?', 'Если агент на компьютере продолжит работать, он не сможет связаться с порталом, пока его не переустановят. Журнал подключений сохранится.', 'Удалить')) return;
          run(async () => { await api.del('/remote/api/agents/' + a.id); m.close(); toast('Агент удалён'); reload(); });
        },
      }, 'Удалить агент'),
      h('button.btn', { onclick: () => m.close() }, 'Закрыть'),
    ],
  });
  search();
}

// ---------------- Журнал ----------------
const journalSort = savedSort('remote-journal', { key: 'created_at', dir: -1 });

async function renderJournal() {
  const rows = await api.get('/remote/api/sessions?limit=500');
  const dur = (s) => {
    if (!s.started_at || !s.ended_at) return null;
    const sec = Math.max(0, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000));
    return sec;
  };
  const fmtDur = (sec) => (sec == null ? '' : sec < 60 ? `${sec} с` : sec < 3600 ? `${Math.floor(sec / 60)} мин ${sec % 60} с` : `${Math.floor(sec / 3600)} ч ${Math.floor(sec % 3600 / 60)} мин`);
  const cols = [
    { key: 'created_at', label: 'Время', value: (s) => new Date(s.created_at).getTime() },
    { key: 'user_name', label: 'Специалист' },
    { key: 'computer_name', label: 'Компьютер' },
    { key: 'windows_user', label: 'Пользователь Windows' },
    { key: 'mode', label: 'Режим' },
    { key: 'status', label: 'Результат' },
    { key: 'dur', label: 'Длительность', value: dur },
    { key: 'ticket_id', label: 'Заявка' },
  ];
  const box = h('div');
  const draw = () => clear(box, rows.length ? h('div.table-wrap', h('table.list',
    sortHead(cols, journalSort, draw),
    h('tbody', sortRows(rows, cols, journalSort).map((s) => {
      const [label, cls] = STATUS[s.status] || [s.status, ''];
      return h('tr',
        h('td', { title: s.viewer_ip ? 'Подключение с ' + s.viewer_ip : '' }, fmtDateTime(s.created_at)),
        h('td', s.user_name),
        h('td', s.device_id ? h('a', { href: '/inventory/#/devices/' + s.device_id }, s.computer_name) : s.computer_name),
        h('td', s.windows_user || ''),
        h('td', s.mode === 'view' ? 'просмотр' : 'управление', s.consent === 'none' ? h('span.lozenge.purple', { style: { marginLeft: '6px' }, title: 'Без уведомления пользователя' }, 'тихо') : null),
        h('td', h('span.lozenge' + cls, label), s.detail ? h('div.muted.small', s.detail) : null),
        h('td', fmtDur(dur(s))),
        h('td', s.ticket_id ? h('a', { href: '/helpdesk/#/tickets/' + s.ticket_id }, '#' + s.ticket_id) : ''));
    })))) : h('div.empty-state', h('h3', 'Подключений ещё не было')));
  page('journal', h('p.muted.small', { style: { margin: '8px 0' } },
    rme.isAdmin ? 'Все подключения специалистов (последние 500).' : 'Ваши подключения (последние 500).'), box);
  draw();
}

// ---------------- Установка ----------------
async function renderInstall() {
  const s = rme.isAdmin ? await api.get('/remote/api/settings') : null;
  const downloads = await api.get('/remote/api/downloads');
  const file = (name, label, hint) => {
    const f = downloads.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h('div.row', { style: { margin: '6px 0' } },
      f ? h('a.btn', { href: '/remote/downloads/' + name, download: name }, '⬇ ' + label) : h('button.btn', { disabled: true }, label),
      h('span.muted.small', f ? fmtSize(f.size) + ' · ' + hint : 'файла нет на сервере (public\\remote\\downloads) — он входит в полный архив обновления'));
  };

  const viewer = h('div.panel',
    h('h3', 'Программа специалиста'),
    h('p', 'Ставится на компьютер каждого специалиста ИТ-отдела (Windows 10/11, 64 бита). Установка не требует прав администратора: достаточно скопировать файл, например, в «Документы» и запустить.'),
    file('ITRemoteViewer.exe', 'ITRemoteViewer.exe', 'программа специалиста'),
    h('ol',
      h('li', 'Скачайте и запустите ITRemoteViewer.exe. Если Windows покажет «Windows защитила ваш компьютер» — «Подробнее» → «Выполнить в любом случае» (у программы пока нет цифровой подписи).'),
      h('li', 'В окне программы нажмите «Открывать ссылки из портала этой программой».'),
      h('li', 'Готово: кнопка «Подключиться» в карточке техники или заявке будет открывать программу.')));

  if (!s) {
    page('install', viewer, h('div.panel', h('h3', 'Агент на компьютерах пользователей'),
      h('p', 'Агенты устанавливает администратор удалённого доступа.')));
    return;
  }

  const server = s.server;
  const cmd = (arch) => `ITRemoteAgent-${arch}.exe --install --server ${server} --code ${s.registration_code}`;
  const codeBox = (text) => h('pre.code-line', { style: { whiteSpace: 'pre-wrap', background: 'var(--n20)', padding: '8px 10px', borderRadius: '3px', userSelect: 'all', fontSize: '12px' } }, text);
  const bat = [
    '@echo off',
    'rem Установка агента «ИТ Удалённый доступ». Запускать от имени администратора',
    'rem (или как сценарий запуска компьютера в групповой политике). Рядом должны лежать ITRemoteAgent-x86.exe и ITRemoteAgent-x64.exe.',
    'chcp 65001 >nul',
    'set SRC=%~dp0',
    'set DST=%ProgramFiles%\\ITRemote',
    'if exist "%DST%\\ITRemoteAgent.exe" sc query ITRemoteAgent >nul 2>&1 && goto :eof',
    'if not exist "%DST%" mkdir "%DST%"',
    'set EXE=ITRemoteAgent-x86.exe',
    'if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set EXE=ITRemoteAgent-x64.exe',
    'if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set EXE=ITRemoteAgent-x64.exe',
    'copy /y "%SRC%%EXE%" "%DST%\\ITRemoteAgent.exe" >nul',
    `"%DST%\\ITRemoteAgent.exe" --install --server ${server} --code ${s.registration_code}`,
    '',
  ].join('\r\n');
  const batLink = h('a.btn', {
    href: URL.createObjectURL(new Blob(['﻿' + bat], { type: 'application/octet-stream' })),
    download: 'install-itremote-agent.bat',
  }, '⬇ install-itremote-agent.bat');

  page('install', viewer,
    h('div.panel',
      h('h3', 'Агент на компьютерах пользователей'),
      h('p', 'Агент — служба Windows «ИТ Удалённый доступ — агент». Работает в Windows XP SP3, 7, 8, 10, 11. После установки компьютер появляется на вкладке «Компьютеры» и сам привязывается к технике в инвентаре по сетевому имени (или MAC/IP-адресу).'),
      file('ITRemoteAgent-x64.exe', 'ITRemoteAgent-x64.exe', 'для 64-битных Windows 7–11'),
      file('ITRemoteAgent-x86.exe', 'ITRemoteAgent-x86.exe', 'для Windows XP и 32-битных Windows'),
      h('h4', { style: { marginTop: '14px' } }, 'Установка на один компьютер'),
      h('p.small', 'Скопируйте exe-файл на компьютер, откройте командную строку от имени администратора в этой папке и выполните:'),
      codeBox(cmd('x64')),
      h('p.muted.small', 'Для Windows XP и 32-битных систем — то же с ITRemoteAgent-x86.exe. Проверка: ITRemoteAgent-x64.exe --info'),
      h('h4', { style: { marginTop: '14px' } }, 'Массовая установка'),
      h('p.small', 'Положите оба exe и этот файл в общую папку и запустите его на компьютерах от имени администратора — или назначьте сценарием запуска компьютера в групповой политике (Конфигурация компьютера → Политики → Конфигурация Windows → Сценарии → Автозагрузка). Повторный запуск на компьютере с агентом ничего не делает.'),
      batLink,
      h('h4', { style: { marginTop: '14px' } }, 'Данные для проверки'),
      h('div.small', 'Адрес сервера для агентов: ', h('code', server), h('span.muted', ' (агент обращается по HTTP, порт 80 или указанный)')),
      h('div.small', 'Код регистрации: ', h('code', s.registration_code), h('span.muted', ' — сменить можно на вкладке «Настройки»')),
      h('div.small', 'Отпечаток ключа сервера: ', h('code', { style: { wordBreak: 'break-all' } }, s.key_fingerprint)),
      h('p.muted.small', 'Агент печатает тот же отпечаток при установке — если они не совпадают, установка подменена.'),
      h('h4', { style: { marginTop: '14px' } }, 'Брандмауэр и сеть'),
      h('ul.small',
        h('li', 'Агент сам открывает в брандмауэре Windows входящий порт TCP 5960 — по нему подключаются специалисты.'),
        h('li', 'Если между отделами стоят другие брандмауэры — разрешите TCP 5960 от компьютеров ИТ-отдела к компьютерам пользователей.'),
        h('li', 'Агенты обращаются к серверу портала по HTTP (порт 80 через nginx, или 3000/3100 напрямую).')),
      h('h4', { style: { marginTop: '14px' } }, 'Удаление'),
      codeBox('"%ProgramFiles%\\ITRemote\\ITRemoteAgent.exe" --uninstall --purge')));
}

// ---------------- Настройки ----------------
async function renderSettings() {
  const s = await api.get('/remote/api/settings');
  const consent = h('select', h('option', { value: 'ask' }, 'Спрашивать разрешение пользователя'),
    h('option', { value: 'notify' }, 'Не спрашивать, только показывать, что подключён специалист'));
  consent.value = s.consent;
  const silent = h('input', { type: 'checkbox', checked: s.allow_silent });
  const ttl = h('input', { type: 'number', min: 30, max: 600, value: s.token_ttl, style: { width: '100px' } });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      await api.put('/remote/api/settings', { consent: consent.value, allow_silent: silent.checked, token_ttl: Number(ttl.value) });
      toast('Настройки сохранены');
    }, save),
  }, 'Сохранить');
  const codeEl = h('code', s.registration_code);
  const regen = h('button.btn', {
    onclick: async () => {
      if (!await confirmDialog('Сменить код регистрации?', 'Уже установленные агенты продолжат работать. Новые агенты нужно будет ставить с новым кодом (обновите файл массовой установки).', 'Сменить')) return;
      run(async () => { const r = await api.post('/remote/api/settings/registration-code'); codeEl.textContent = r.registration_code; toast('Код изменён'); }, regen);
    },
  }, 'Сменить код');
  page('settings',
    h('div.panel.stack', { style: { gap: '14px', maxWidth: '760px' } },
      h('label.field', h('span', 'Перед подключением'), consent),
      h('p.hint', 'В любом режиме у пользователя на экране видна плашка «Подключён специалист: ФИО» с кнопкой «Отключить». Если в Windows никто не вошёл (экран входа), разрешение не спрашивается.'),
      h('label.check', silent, 'Разрешить администраторам удалённого доступа подключаться без уведомления пользователя'),
      h('p.hint', 'Нужно для серверов и компьютеров без пользователя. Такие подключения отмечаются в журнале.'),
      h('label.field', h('span', 'Сколько секунд действует ссылка на подключение'), ttl),
      h('div', save)),
    h('div.panel.stack', { style: { gap: '10px', maxWidth: '760px' } },
      h('h3', 'Код регистрации агентов'),
      h('div.row', codeEl, regen),
      h('p.hint', 'Код нужен только при установке агента. Его знание не даёт доступа к компьютерам: подключиться можно только через портал.')));
}

boot().catch((e) => {
  document.getElementById('app').textContent = 'Ошибка загрузки: ' + e.message;
});
