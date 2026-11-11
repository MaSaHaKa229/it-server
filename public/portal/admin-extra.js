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
const KIND = { auto: 'по расписанию', manual: 'вручную', 'before-restore': 'перед восстановлением', uploaded: 'загружена' };

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

  const rows = d.files.map((f) => h('tr',
    h('td', h('b', fmtDateTime(f.mtime))),
    h('td', KIND[f.kind] || f.kind),
    h('td.nowrap', fmtSize(f.size)),
    h('td.small.muted', f.name),
    h('td.nowrap', { style: { textAlign: 'right' } },
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
        h('thead', h('tr', h('th', 'Создана'), h('th', 'Как'), h('th', 'Размер'), h('th', 'Файл'), h('th', ''))),
        h('tbody', rows.length ? rows : h('tr.empty', h('td', { colspan: 5 }, 'Копий пока нет'))))),
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
