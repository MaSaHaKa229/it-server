// Администрирование портала: почта и уведомления, резервные копии, журнал входов и действий
import { h, clear, run, toast, confirmDialog, fmtDateTime } from '/shared/ui.js';
import { api } from './shell.js';

const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

// ====================== Почта и уведомления ======================
export async function renderMailNotify(box) {
  const [m, th] = await Promise.all([api.get('/api/admin/settings/mail'), api.get('/api/admin/settings/notify')]);
  const f = {
    host: h('input', { type: 'text', value: m.host, placeholder: 'mail.company.local' }),
    port: h('input', { type: 'number', value: m.port || 25, min: 1, max: 65535, style: { width: '100px' } }),
    secure: h('input', { type: 'checkbox', checked: m.secure }),
    user: h('input', { type: 'text', value: m.user, placeholder: 'it-portal@company.local', autocomplete: 'off' }),
    pass: h('input', { type: 'password', placeholder: m.has_pass ? 'сохранён — оставьте пустым, чтобы не менять' : 'если сервер требует вход', autocomplete: 'new-password' }),
    from: h('input', { type: 'text', value: m.from, placeholder: 'ИТ-портал <it-portal@company.local>' }),
    reject: h('input', { type: 'checkbox', checked: m.reject }),
    disabled: h('input', { type: 'checkbox', checked: m.disabled }),
  };
  const testTo = h('input', { type: 'email', placeholder: 'кому отправить проверочное письмо' });
  const status = m.enabled
    ? h('div.info-box', `Почта работает (${m.source === 'env' ? 'настройки из файла .env' : 'настройки ниже'}).`)
    : h('div.info-box', m.disabled ? 'Отправка писем выключена.' : 'Почта не настроена — письма не отправляются (уведомления только на сайте).');

  const t = {
    hd_due_hours: h('input', { type: 'number', min: 1, max: 240, value: th.hd_due_hours, style: { width: '90px' } }),
    warranty_days: h('input', { type: 'number', min: 1, max: 365, value: th.warranty_days, style: { width: '90px' } }),
    offline_days: h('input', { type: 'number', min: 1, max: 365, value: th.offline_days, style: { width: '90px' } }),
    audit_days: h('input', { type: 'number', min: 0, max: 30, value: th.audit_days, style: { width: '90px' } }),
  };

  clear(box,
    h('div.panel',
      h('h2', { style: { marginTop: 0 } }, 'Почта (SMTP)'),
      h('p.muted', 'Через этот сервер портал отправляет письма: уведомления сотрудникам службы ИТ (каждый сам выбирает, что получать), ',
        'письма заявителям helpdesk и коды подтверждения регистрации.'),
      status,
      m.source === 'env' ? h('p.hint', `Сейчас используются настройки из .env (${m.env.host}:${m.env.port}). Если заполнить поля ниже — будут использоваться они.`) : null,
      h('div.form-grid', { style: { marginTop: '12px' } },
        h('label.field', h('span', 'SMTP-сервер'), f.host),
        h('label.field', h('span', 'Порт'), f.port, h('div.hint', '25 — обычно; 465 — SSL; 587 — с STARTTLS')),
        h('label.field', h('span', 'Логин (если нужен)'), f.user),
        h('label.field', h('span', 'Пароль'), f.pass),
        h('label.field', h('span', 'Отправитель (От кого)'), f.from)),
      h('div.stack', { style: { gap: '6px', marginTop: '8px' } },
        h('label.check', f.secure, 'Защищённое соединение SSL (порт 465)'),
        h('label.check', f.reject, 'Проверять сертификат сервера (снимите, если сертификат самоподписанный)'),
        h('label.check', f.disabled, 'Не отправлять письма совсем')),
      h('div.row.wrap', { style: { marginTop: '14px', gap: '8px' } },
        h('button.btn.primary', {
          onclick: (e) => run(async () => {
            await api.put('/api/admin/settings/mail', {
              host: f.host.value, port: f.port.value, secure: f.secure.checked, user: f.user.value, from: f.from.value,
              reject: f.reject.checked, disabled: f.disabled.checked, ...(f.pass.value ? { pass: f.pass.value } : {}),
            });
            toast('Настройки почты сохранены'); renderMailNotify(box);
          }, e.currentTarget),
        }, 'Сохранить'),
        h('span', { style: { width: '20px' } }),
        testTo,
        h('button.btn', {
          onclick: (e) => run(async () => {
            await api.post('/api/admin/settings/mail/test', { to: testTo.value.trim() });
            toast('Проверочное письмо отправлено');
          }, e.currentTarget),
        }, 'Отправить проверочное письмо'))),
    h('div.panel',
      h('h2', { style: { marginTop: 0 } }, 'Когда предупреждать'),
      h('p.muted', 'Общие пороги для всех. Что именно получать — на сайте и на почту — каждый выбирает сам в «Настройках уведомлений» (колокольчик в шапке).'),
      h('div.stack', { style: { gap: '10px' } },
        h('label.row', t.hd_due_hours, h('span', 'часов до срока заявки — «срок подходит к концу»')),
        h('label.row', t.warranty_days, h('span', 'дней до окончания гарантии или лицензии')),
        h('label.row', t.offline_days, h('span', 'дней без ответа в сети — «техника давно не появлялась в сети»')),
        h('label.row', t.audit_days, h('span', 'дней до даты инвентаризации — напоминание (0 — в сам день)'))),
      h('p.hint', 'Гарантия и лицензии берутся из дополнительных полей типа «Дата» у техники и ПО, в названии которых есть слова ',
        '«гарантия», «лицензия», «срок», «окончание», «действует», «истекает». Расходники принтеров — порог в ИТ-инвентарь → Настройки → «Сведения из сети».'),
      h('button.btn.primary', {
        style: { marginTop: '8px' },
        onclick: (e) => run(async () => {
          await api.put('/api/admin/settings/notify', Object.fromEntries(Object.entries(t).map(([k, i]) => [k, Number(i.value)])));
          toast('Сохранено');
        }, e.currentTarget),
      }, 'Сохранить')));
}

// ====================== Резервные копии ======================
const KIND = { auto: 'по расписанию', manual: 'вручную', 'before-restore': 'перед восстановлением', uploaded: 'загружена', 'before-update': 'перед обновлением' };

export async function renderBackup(box) {
  const d = await api.get('/api/admin/backup');
  const s = d.settings;
  const st = d.state || {};
  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const time = h('input', { type: 'time', value: s.time, style: { width: '110px' } });
  const keep = h('input', { type: 'number', min: 1, max: 365, value: s.keep, style: { width: '80px' } });
  const dir = h('input', { type: 'text', value: s.dir, placeholder: d.default_dir, style: { width: '100%' } });
  const file = h('input', { type: 'file', accept: '.itbak' });
  const reload = () => renderBackup(box);

  const last = st.last_ok_at
    ? h('div.info-box', 'Последняя копия: ', h('b', fmtDateTime(st.last_ok_at)), ` — ${st.last_file} (${fmtSize(st.last_size || 0)})`)
    : h('div.info-box', 'Резервных копий ещё не было.');
  const err = st.last_error && (!st.last_ok_at || new Date(st.last_error_at) > new Date(st.last_ok_at))
    ? h('div.error-box', { style: { marginTop: '8px' } }, `Ошибка ${fmtDateTime(st.last_error_at)}: ${st.last_error}`) : null;

  const vf = (d.verify && d.verify.files) || {};
  const checked = (f) => {
    const v = vf[f.name];
    if (!v) return h('span.muted.small', 'не проверялась');
    return v.ok
      ? h('span.small', { title: `Таблиц ${v.tables}, записей ${v.rows}, ${v.seconds} с` }, h('span.lozenge.green', 'можно восстановить'), ' ', h('span.muted', fmtDateTime(v.at)))
      : h('span.small', { title: v.error }, h('span.lozenge.red', 'ошибка'), ' ', h('span.muted', v.error.slice(0, 80)));
  };
  const rows = d.files.map((f) => h('tr',
    h('td', h('b', fmtDateTime(f.mtime))),
    h('td', KIND[f.kind] || f.kind),
    h('td.nowrap', fmtSize(f.size)),
    h('td.small.muted', f.name),
    h('td', checked(f)),
    h('td.nowrap', { style: { textAlign: 'right' } },
      h('button.btn.sm', {
        title: 'Прочитать копию целиком и проверить, что из неё можно восстановиться (данные портала не меняются)',
        onclick: (e) => run(async () => {
          const r = await api.post(`/api/admin/backup/files/${encodeURIComponent(f.name)}/verify`);
          if (r.ok) toast(`Копия в порядке: таблиц ${r.tables}, записей ${r.rows}`); else toast(r.error, 'error', 'Копия не прошла проверку');
          reload();
        }, e.currentTarget),
      }, 'Проверить'), ' ',
      h('a.btn.sm', { href: `/api/admin/backup/files/${encodeURIComponent(f.name)}`, download: f.name }, 'Скачать'), ' ',
      h('button.btn.sm', { onclick: () => restoreDialog(f, reload) }, 'Восстановить…'), ' ',
      h('button.btn.sm.subtle', {
        title: 'Удалить файл копии',
        onclick: async () => {
          if (!(await confirmDialog('Удалить резервную копию?', `Файл копии от ${fmtDateTime(f.mtime)} будет удалён с сервера.`))) return;
          run(async () => { await api.del(`/api/admin/backup/files/${encodeURIComponent(f.name)}`); toast('Удалено'); reload(); });
        },
      }, '✕'))));

  clear(box,
    h('div.panel',
      h('div.row', h('h2', { style: { margin: 0 } }, 'Резервные копии'), h('span.spacer'),
        h('button.btn.primary', {
          onclick: (e) => run(async () => {
            const r = await api.post('/api/admin/backup/run');
            toast(`Копия создана: ${fmtSize(r.size)}, записей ${r.rows}`); reload();
          }, e.currentTarget),
        }, 'Создать копию сейчас')),
      h('p.muted', 'В копию входит вся база портала: ИТ-инвентарь, пользователи, документы с файлами, задачи, заявки с вложениями, настройки. ',
        'Копии хранятся в папке на сервере — лучше указать папку на другом диске или сетевую и время от времени скачивать копию на другой компьютер.'),
      last, err,
      h('div.stack', { style: { gap: '10px', marginTop: '14px' } },
        h('label.check', enabled, 'Делать копию каждый день'),
        h('label.row', h('span', 'Время:'), time, h('span', { style: { marginLeft: '16px' } }, 'Хранить последних:'), keep, h('span', 'копий по расписанию')),
        h('label.field', h('span', 'Папка для копий'), dir, h('div.hint', `Пусто — ${d.default_dir}. Полный путь, например D:\\Backup\\it-portal или \\\\nas\\backup\\it-portal (у службы портала должен быть доступ на запись).`)),
        h('div', h('button.btn.primary', {
          onclick: (e) => run(async () => {
            await api.put('/api/admin/backup/settings', { enabled: enabled.checked, time: time.value, keep: Number(keep.value), dir: dir.value });
            toast('Настройки сохранены'); reload();
          }, e.currentTarget),
        }, 'Сохранить настройки')))),
    h('div.panel',
      h('div.row', h('h3', { style: { margin: 0 } }, `Копии в папке ${d.dir}`), h('span.spacer'),
        h('label.btn', { style: { cursor: 'pointer' } }, 'Загрузить файл копии…', file)),
      h('div.table-wrap', { style: { marginTop: '10px' } }, h('table.list',
        h('thead', h('tr', h('th', 'Создана'), h('th', 'Как'), h('th', 'Размер'), h('th', 'Файл'), h('th', 'Проверка'), h('th', ''))),
        h('tbody', rows.length ? rows : h('tr.empty', h('td', { colspan: 6 }, 'Копий пока нет'))))),
      h('p.hint', 'Раз в неделю свежая копия проверяется автоматически: портал читает её целиком и пробует загрузить во временные таблицы. ',
        'Если копия повреждена — придёт уведомление, а в «Состоянии системы» будет ошибка.'),
      h('p.hint', 'Восстановление заменяет все данные портала содержимым копии. Перед восстановлением автоматически создаётся копия текущего состояния — ',
        'если восстановили не то, можно вернуться к ней.')));
  file.style.display = 'none';
  file.addEventListener('change', () => run(async () => {
    if (!file.files[0]) return;
    const fd = new FormData(); fd.append('file', file.files[0]);
    const r = await fetch('/api/admin/backup/upload', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-Requested-With': 'portal' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Ошибка загрузки');
    toast(`Файл загружен: копия от ${fmtDateTime(j.created_at)}`); reload();
  }));
}

async function restoreDialog(f, reload) {
  const { modal } = await import('/shared/ui.js');
  const info = h('div.muted', 'Проверяю файл…');
  const word = h('input', { type: 'text', placeholder: 'ВОССТАНОВИТЬ', autocomplete: 'off' });
  const go = h('button.btn.danger', { disabled: true }, 'Восстановить');
  word.addEventListener('input', () => { go.disabled = word.value.trim() !== 'ВОССТАНОВИТЬ'; });
  const m = modal({
    title: 'Восстановление из резервной копии',
    body: h('div.stack', { style: { gap: '12px' } },
      h('div.error-box', 'Все текущие данные портала будут заменены данными из копии от ', h('b', fmtDateTime(f.mtime)), '. ',
        'Всё, что было сделано после этого, пропадёт (копия текущего состояния будет создана автоматически).'),
      info,
      h('label.field', h('span', 'Для подтверждения введите слово ВОССТАНОВИТЬ'), word)),
    footer: [h('button.btn', { onclick: () => m.close() }, 'Отмена'), go],
  });
  api.get(`/api/admin/backup/files/${encodeURIComponent(f.name)}/info`)
    .then((i) => clear(info, `В копии: таблиц ${i.tables}, записей ${i.rows}. Создана ${fmtDateTime(i.created_at)} на компьютере ${i.host || '—'}.`))
    .catch((e) => clear(info, h('span.error', e.message)));
  go.addEventListener('click', () => run(async () => {
    const r = await api.post(`/api/admin/backup/files/${encodeURIComponent(f.name)}/restore`, { confirm: 'ВОССТАНОВИТЬ' });
    m.close();
    toast(`Восстановлено записей: ${r.rows}. Копия до восстановления: ${r.safety_copy}`);
    reload();
  }, go));
}

// ====================== Журнал ======================
const auditFilter = { action: '', q: '', from: '', to: '', offset: 0 };

function describe(x) {
  const d = x.details || {};
  const parts = [];
  if (x.object) parts.push(x.object);
  if (x.action === 'login_failed' && d.username) parts.push(`логин «${d.username}»`);
  if (d.role) parts.push(`роль: ${d.role.join ? d.role.join(' → ') : d.role}`);
  if (d.is_active) parts.push(d.is_active[1] ? 'включён' : 'отключён');
  if (d.modules) parts.push('доступ: ' + Object.entries(d.modules).map(([k, v]) => `${k} ${JSON.stringify(v[0])} → ${JSON.stringify(v[1])}`).join('; '));
  if (d.password) parts.push(`пароль ${d.password}`);
  if (d.email) parts.push(`e-mail: ${d.email[0] || '—'} → ${d.email[1] || '—'}`);
  if (d.full_name) parts.push(`ФИО: ${d.full_name[0] || '—'} → ${d.full_name[1] || '—'}`);
  if (d.error) parts.push(`ошибка: ${d.error}`);
  if (d.rows != null && x.action.startsWith('backup')) parts.push(`записей ${d.rows}`);
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !['username', 'role', 'is_active', 'modules', 'password', 'email', 'full_name', 'error', 'rows', 'tables', 'size', 'kind', 'safety_copy'].includes(k)));
  if (Object.keys(rest).length && !['login', 'logout'].includes(x.action)) parts.push(JSON.stringify(rest).slice(0, 300));
  return parts.join(' · ');
}

export async function renderAudit(box) {
  const action = h('select',
    [['', 'Все события'], ['logins', 'Входы и выходы'], ['failed', 'Неудачные попытки входа'], ['admin', 'Действия администраторов']]
      .map(([v, l]) => h('option', { value: v, selected: auditFilter.action === v }, l)));
  const q = h('input', { type: 'search', placeholder: 'Пользователь, объект, IP…', value: auditFilter.q });
  const from = h('input', { type: 'date', value: auditFilter.from });
  const to = h('input', { type: 'date', value: auditFilter.to });
  const table = h('div');
  const pager = h('div.row', { style: { marginTop: '10px' } });

  async function load() {
    const p = new URLSearchParams({ ...auditFilter, limit: 100 });
    const d = await api.get('/api/admin/audit?' + p);
    clear(table, h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Когда'), h('th', 'Кто'), h('th', 'Событие'), h('th', 'Подробности'), h('th', 'IP'))),
      h('tbody', d.items.length ? d.items.map((x) => h('tr',
        h('td.nowrap', fmtDateTime(x.at)),
        h('td', x.user_name || x.username || h('span.muted', '—')),
        h('td', h('span.lozenge' + (x.action === 'login_failed' || x.action === 'backup_failed' ? '.red' : x.action.startsWith('login') || x.action === 'logout' ? '' : '.blue'),
          d.actions[x.action] || x.action)),
        h('td.small', describe(x)),
        h('td.small.muted.nowrap', x.ip || ''))) : h('tr.empty', h('td', { colspan: 5 }, 'Записей нет'))))));
    clear(pager,
      h('span.muted', `Записей: ${d.total}`), h('span.spacer'),
      auditFilter.offset > 0 ? h('button.btn.sm', { onclick: () => { auditFilter.offset = Math.max(0, auditFilter.offset - 100); load(); } }, '← Новее') : null,
      auditFilter.offset + 100 < d.total ? h('button.btn.sm', { onclick: () => { auditFilter.offset += 100; load(); } }, 'Старее →') : null);
  }
  const apply = () => { Object.assign(auditFilter, { action: action.value, q: q.value.trim(), from: from.value, to: to.value, offset: 0 }); load(); };
  action.addEventListener('change', apply); from.addEventListener('change', apply); to.addEventListener('change', apply);
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 300); });

  const excel = h('a.btn', { title: 'Выгрузить в Excel записи с текущими отборами' }, 'Excel');
  const syncExcel = () => { excel.href = '/api/admin/audit/export.xlsx?' + new URLSearchParams({ action: auditFilter.action, q: auditFilter.q, from: auditFilter.from, to: auditFilter.to }); };
  syncExcel();
  [action, q, from, to].forEach((x) => x.addEventListener('change', () => setTimeout(syncExcel, 0)));
  q.addEventListener('input', () => setTimeout(syncExcel, 400));
  clear(box,
    h('p.muted', { style: { marginTop: 0 } }, 'Входы в портал (в том числе неудачные попытки), изменения пользователей и прав, настроек, резервные копии. Записи хранятся бессрочно.'),
    h('div.toolbar', action, h('div.search-box', q), h('span.muted', 'с'), from, h('span.muted', 'по'), to, h('span.spacer'), excel),
    table, pager);
  await load();
}

// ====================== Все настройки портала в одном месте ======================
const SETTINGS_MAP = [
  ['Портал', [
    ['Пользователи и доступ', '/admin#users', 'кто входит в портал и что может в каждом разделе'],
    ['Уведомления и почта', '/admin#notify', 'почтовый сервер, пороги «за сколько предупреждать»'],
    ['Резервные копии', '/admin#backup', 'расписание, папка, восстановление'],
    ['Журнал входов и действий', '/admin#audit', 'кто и когда входил, что менял'],
    ['Состояние системы', '/admin#status', 'самопроверка, проверка возможностей Windows, фоновые задания, ошибки'],
    ['Оформление', '/admin#branding', 'название предприятия, портала и сайта заявок, логотип'],
  ]],
  ['ИТ-инвентарь', [
    ['Типы техники', '/inventory/#/settings/types', 'какие поля у какого типа'],
    ['Состояния техники', '/inventory/#/settings/statuses', 'используется, в ремонте, списано…'],
    ['Дополнительные поля', '/inventory/#/settings/fields', 'в т. ч. поля-даты для уведомлений о гарантии'],
    ['Справочники', '/inventory/#/catalog', 'модели, отделы, кабинеты, сотрудники…'],
    ['Сведения из сети', '/inventory/#/settings/netprobe', 'учётная запись AD/WMI, SNMP, расходники, подключение к сеансу'],
    ['Формат данных из сети', '/inventory/#/settings/netformat', 'как записывать данные WMI в карточку'],
    ['Сканирование по расписанию', '/inventory/#/netscan', 'строка «По расписанию» на вкладке сканирования'],
    ['Права читателей инвентаря', '/inventory/#/users', 'какие типы, отделы и поля видит читатель'],
    ['Возможности (учёт лицензий)', '/inventory/#/settings/features', 'показывать или скрыть ото всех раздел «Лицензии ПО»'],
    ['Склад расходников', '/inventory/#/stock', 'позиции, минимальные остатки для уведомлений'],
  ]],
  ['Заявки', [
    ['Автоназначение', '/helpdesk/#/rules', 'кому сразу попадает новая заявка'],
    ['Виды проблем', '/helpdesk/#/categories', 'список для сотрудников, исполнитель и нормативный срок'],
    ['Статусы заявок', '/helpdesk/#/statuses', 'новая, в работе, выполнена…'],
    ['Заявители', '/helpdesk/#/requesters', 'зарегистрированные сотрудники сайта заявок'],
    ['Регистрация и почта сайта заявок', '/helpdesk/#/settings', 'домены почты, подтверждение регистрации'],
  ]],
  ['Задачи и календарь', [
    ['Категории задач', '/calendar/#/categories', 'названия и цвета'],
    ['Цвета календаря', '/calendar/#/colors', 'цвета приоритетов, статусов, отпусков'],
  ]],
  ['Документы', [
    ['Виды документов', '/docs/types', 'приказы, регламенты, ГОСТы…'],
    ['Папки и теги', '/docs/folders', 'структура хранения и доступ по папкам'],
  ]],
];

export function renderSettingsMap(box) {
  clear(box,
    h('p.muted', { style: { marginTop: 0 } }, 'Все настройки портала в одном месте. Сами страницы остаются в своих разделах — здесь только ссылки на них.'),
    h('div.settings-map', SETTINGS_MAP.map(([group, items]) => h('div.panel',
      h('h2', { style: { marginTop: 0 } }, group),
      h('div.stack', { style: { gap: '10px' } }, items.map(([label, href, hint]) => h('div',
        h('a', { href, style: { fontWeight: 500 } }, label),
        h('div.small.muted', hint))))))));
}

// ====================== Состояние системы ======================
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} ГБ` : n >= 1e6 ? `${Math.round(n / 1e6)} МБ` : `${Math.max(1, Math.round(n / 1e3))} КБ`);
const dur = (s) => { const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const mm = Math.floor((s % 3600) / 60); return d ? `${d} дн. ${hh} ч` : hh ? `${hh} ч ${mm} мин` : `${mm} мин`; };
const MARK = { true: ['✓', '#36B37E'], warn: ['!', '#FF8B00'], false: ['✕', '#DE350B'] };
const JOB_STATE = { ok: ['работает', '.green'], waiting: ['ещё не запускалось', ''], late: ['давно не запускалось', '.yellow'], error: ['ошибка', '.red'] };

// Оформление: название предприятия, портала и сайта заявок, логотип
export async function renderBranding(box) {
  const b = await api.get('/api/branding');
  const company = h('input', { type: 'text', value: b.company || '', placeholder: 'Например: ООО «Ромашка»' });
  const title = h('input', { type: 'text', value: b.portal_title || '', placeholder: 'ИТ-портал' });
  const short = h('input', { type: 'text', value: b.portal_short || '', placeholder: 'Портал', style: { width: '200px' } });
  const hd = h('input', { type: 'text', value: b.helpdesk_title || '', placeholder: 'HelpDesk' });
  const hdLogo = h('input', { type: 'checkbox', checked: b.helpdesk_logo !== false });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp' });
  let logo = b.logo || null;
  const prev = h('span.brand-logo', { style: { width: '48px', height: '48px', fontSize: '18px', borderRadius: '6px' } }, 'IT');
  const drawLogo = () => Object.assign(prev.style, logo
    ? { backgroundImage: `url("${logo}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundColor: 'transparent', color: 'transparent' }
    : { backgroundImage: '', backgroundColor: '', color: '' });
  drawLogo();
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 200 * 1024) { toast('Файл больше 200 КБ — уменьшите картинку', 'error'); file.value = ''; return; }
    const r = new FileReader();
    r.onload = () => { logo = r.result; drawLogo(); };
    r.readAsDataURL(f);
  });
  file.style.display = 'none';
  clear(box, h('div.panel',
    h('p.muted', { style: { marginTop: 0 } }, 'Как портал и сайт заявок называются и выглядят для сотрудников. Меняется сразу у всех (после обновления страницы).'),
    h('div.stack', { style: { gap: '12px', maxWidth: '640px' } },
      h('label.field', h('span', 'Название предприятия'), company, h('div.hint', 'Показывается на странице входа, на главной и на сайте заявок. Можно оставить пустым.')),
      h('label.field', h('span', 'Название портала'), title, h('div.hint', 'На странице входа и в заголовке окна браузера')),
      h('label.field', h('span', 'Короткое название (в шапке рядом с логотипом)'), short),
      h('label.field', h('span', 'Название сайта заявок'), hd, h('div.hint', 'Вместо «HelpDesk» — например, «Заявки в службу ИТ»')),
      h('div.field', h('span', 'Логотип'),
        h('div.row', { style: { gap: '12px', alignItems: 'center' } }, prev,
          h('label.btn', { style: { cursor: 'pointer' } }, 'Выбрать картинку…', file),
          h('button.btn.subtle', { onclick: () => { logo = null; file.value = ''; drawLogo(); } }, 'Убрать')),
        h('div.hint', 'Квадратная картинка PNG, JPG или SVG до 200 КБ — показывается в шапке всех разделов вместо значка «IT».')),
      h('label.check', hdLogo, 'Тот же логотип на сайте заявок'),
      h('div', h('button.btn.primary', { onclick: (e) => run(async () => {
        const v = await api.put('/api/admin/branding', { company: company.value, portal_title: title.value, portal_short: short.value,
          helpdesk_title: hd.value, logo, helpdesk_logo: hdLogo.checked });
        window.portalPrefs && window.portalPrefs.brand && window.portalPrefs.brand(v);
        toast('Оформление сохранено');
      }, e.currentTarget) }, 'Сохранить')))));
}

// Проверка возможностей Windows: PowerShell, AD, WMI, arp/ping, подключение к сеансу
function winCheckPanel() {
  const target = h('input', { type: 'text', placeholder: 'Например: BUH-PC01', style: { width: '220px' } });
  try { target.value = localStorage.getItem('portal.wincheck.target') || ''; } catch { /* нет хранилища */ }
  const out = h('div');
  const btn = h('button.btn.primary', 'Проверить');
  const draw = (j) => {
    if (!j) { clear(out); return; }
    clear(out,
      h('table.list', { style: { marginTop: '10px' } }, h('tbody',
        j.checks.map((c) => h('tr',
          h('td', { style: { width: '32px', fontWeight: 700, color: MARK[String(c.ok)][1] } }, MARK[String(c.ok)][0]),
          h('td', { style: { width: '260px' } }, h('b', c.title)),
          h('td', c.text, c.ms > 1500 ? h('span.muted.small', ` · ${Math.round(c.ms / 1000)} с`) : null))),
        j.current ? h('tr', h('td', '…'), h('td', h('b', j.current)), h('td.muted', 'проверяется…')) : null)),
      j.finished_at ? h('p.muted.small', `Проверено ${fmtDateTime(j.finished_at)}${j.target ? `, компьютер ${j.target}` : ''}.`) : null);
  };
  const poll = async () => {
    const j = await api.get('/api/admin/status/windows');
    draw(j);
    if (j && !j.finished_at) setTimeout(() => poll().catch(() => {}), 1500);
    else btn.disabled = false;
  };
  btn.addEventListener('click', () => run(async () => {
    try { localStorage.setItem('portal.wincheck.target', target.value.trim()); } catch { /* нет хранилища */ }
    btn.disabled = true;
    await api.post('/api/admin/status/windows', { target: target.value.trim() });
    await poll();
  }));
  poll().catch(() => {});
  return h('div.panel',
    h('h2', { style: { marginTop: 0 } }, 'Проверка возможностей Windows'),
    h('p.muted', 'Пробует на этом сервере всё, что портал делает средствами Windows: PowerShell, поиск в Active Directory, ',
      'сбор характеристик и установленного ПО по WMI, команды arp и ping, программы для подключения к сеансу. ',
      'Укажите имя включённого компьютера сотрудника — на нём проверяются AD и WMI (учётная запись — из настроек «Сведения из сети»).'),
    h('div.row', h('span', 'Компьютер:'), target, btn),
    out);
}

export async function renderStatus(box) {
  const d = await api.get('/api/admin/status');
  const row = (k, v) => h('tr', h('td.muted', { style: { width: '220px' } }, k), h('td', v));
  const bad = d.checks.filter((c) => c.ok !== true).length;
  clear(box,
    h('div.row', { style: { marginBottom: '12px' } },
      h('span', bad ? h('b', { style: { color: '#DE350B' } }, `Требует внимания: ${bad}`) : h('b', { style: { color: '#006644' } }, 'Всё в порядке')),
      h('span.spacer'),
      h('button.btn', { onclick: () => run(() => renderStatus(box)) }, 'Обновить')),
    h('div.panel',
      h('h2', { style: { marginTop: 0 } }, 'Самопроверка'),
      h('table.list', h('tbody', d.checks.map((c) => h('tr',
        h('td', { style: { width: '32px', fontWeight: 700, color: MARK[String(c.ok)][1] } }, MARK[String(c.ok)][0]),
        h('td', { style: { width: '260px' } }, h('b', c.title)),
        h('td', c.text)))))),
    winCheckPanel(),
    h('div.panel',
      h('h2', { style: { marginTop: 0 } }, 'Фоновые задания'),
      h('table.list',
        h('thead', h('tr', h('th', 'Задание'), h('th', 'Состояние'), h('th', 'Последний запуск'), h('th', 'Результат'), h('th', 'Запусков / ошибок'))),
        h('tbody', d.jobs.map((j) => h('tr',
          h('td', j.label),
          h('td', h('span.lozenge' + JOB_STATE[j.state][1], JOB_STATE[j.state][0])),
          h('td.nowrap', j.lastRun ? fmtDateTime(j.lastRun) : '—'),
          h('td.small', j.state === 'error' ? h('span', { style: { color: '#DE350B' } }, j.lastError) : (j.info || '')),
          h('td', `${j.runs} / ${j.fails}`))))),
      h('p.hint', 'Задания запускаются сами: опрос принтеров — раз в 2 часа, письма — раз в 15 минут, повторы задач — раз в 6 часов, ',
        'копия и сканирование — по расписанию. Счётчики обнуляются при перезапуске портала.')),
    h('div.form-grid', { style: { alignItems: 'start' } },
      h('div.panel',
        h('h2', { style: { marginTop: 0 } }, 'Портал'),
        h('table.list', h('tbody',
          row('Версия', [d.version.version, d.version.built ? ` от ${fmtDateTime(d.version.built)}` : ' (сборка разработчика)', d.version.commit ? h('span.muted', ` · ${d.version.commit}`) : null]),
          row('Компьютер', `${d.server.hostname} · ${d.server.platform}`),
          row('Node.js', d.server.node),
          row('Работает без перезапуска', `${dur(d.server.uptime)} (с ${fmtDateTime(d.server.started)})`),
          row('Память портала', `${mb(d.server.memory)} · свободно на компьютере ${mb(d.server.freemem)} из ${mb(d.server.totalmem)}`),
          row('Папка', d.server.folder),
          row('Диск', d.server.disk ? `свободно ${mb(d.server.disk.free)} из ${mb(d.server.disk.total)}` : '—')))),
      h('div.panel',
        h('h2', { style: { marginTop: 0 } }, 'База данных'),
        h('table.list', h('tbody',
          row('База', `${d.db.name} · ${d.db.version}`),
          row('Размер', mb(d.db.size)),
          row('Подключений', String(d.db.connections)),
          row('Последняя копия', d.backup && d.backup.last_ok_at ? `${fmtDateTime(d.backup.last_ok_at)} · ${d.backup.last_file || ''}` : 'не было'),
          row('Самые большие таблицы', h('div.small', d.db.tables.map((t) => h('div', `${t.name} — ${mb(t.size)}`)))))))),
    h('div.panel',
      h('h2', { style: { marginTop: 0 } }, 'Последние ошибки'),
      d.errors.length ? h('div', { style: { maxHeight: '360px', overflow: 'auto' } }, d.errors.map((e) => h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--n30)' } },
        h('span.muted.small', fmtDateTime(e.at)), h('pre.small', { style: { margin: '2px 0 0', whiteSpace: 'pre-wrap', fontFamily: 'inherit' } }, e.text))))
        : h('p.muted', 'Ошибок с момента запуска не было.'),
      h('p.hint', 'Полный журнал — файл portal.log в папке портала.')));
}
