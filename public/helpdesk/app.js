// Сайт заявок в службу ИТ для сотрудников предприятия
import { h, clear, makeApi, run, toast, fmtDateTime, relTime, statusPill, parseHash, topbar, logoStyle } from '/shared/ui.js';
import { thread, fileList, fileInput, historyList } from '/shared/thread.js';

const api = makeApi('/api', { csrf: 'helpdesk', onUnauthorized: () => { if (me) { me = null; location.hash = '#/login'; } } });
const fileUrl = (f) => '/api/attachments/' + f.id;
const app = document.getElementById('app');
let me = null;
let cfg = null;
let statuses = [];

async function boot() {
  cfg = await api.get('/config');
  document.title = brand().helpdesk_title;
  try { me = await api.get('/me'); } catch { me = null; }
  window.addEventListener('hashchange', route);
  route();
}

const PUBLIC = ['login', 'register', 'verify', 'forgot', 'pending'];

// ---------------- Выбор отдела ----------------
// Отделы — из справочника ИТ-инвентаря. Поиск по названию, полному и короткому названию.
// Если отдела нет в списке, можно оставить своё название.
let departmentsCache = null;
const loadDepartments = () => {
  if (!departmentsCache) departmentsCache = api.get('/departments').then((d) => d.departments).catch(() => { departmentsCache = null; return []; });
  return departmentsCache;
};
const normText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function departmentPicker(cur) {
  const input = h('input', { type: 'text', value: cur.department || '', autocomplete: 'off', placeholder: 'Начните вводить: название, полное или короткое' });
  const list = h('div.dp-list.hidden');
  const note = h('div.hint');
  let id = cur.department_id || null;
  let items = [];
  let shown = [];
  let active = -1;
  let open = false;

  const updateNote = () => {
    note.textContent = id ? 'Отдел выбран из списка'
      : input.value.trim() && items.length ? 'Отдел не выбран из списка — будет сохранено, как написано' : '';
    note.className = 'hint' + (id ? ' dp-ok' : '');
  };
  const pick = (d) => { id = d.id; input.value = d.name; open = false; draw(); updateNote(); };
  function draw() {
    const q = normText(input.value);
    shown = items.filter((d) => !q || [d.name, d.full_name, d.short_name].some((x) => normText(x).indexOf(q) !== -1)).slice(0, 60);
    if (active >= shown.length) active = shown.length - 1;
    clear(list, shown.length
      ? shown.map((d, i) => h('div.dp-item' + (i === active ? '.active' : ''), {
        onmousedown: (e) => { e.preventDefault(); pick(d); },
      }, h('div', h('b', d.name), d.short_name ? h('span.muted', ' · ' + d.short_name) : null),
      d.full_name ? h('div.small.muted', d.full_name) : null))
      : h('div.dp-empty', items.length ? 'Такого отдела нет в списке — можно оставить своё название' : 'Список отделов пуст — напишите название'));
    if (open && (items.length || q)) list.classList.remove('hidden'); else list.classList.add('hidden');
  }
  input.addEventListener('input', () => { id = null; open = true; active = -1; draw(); updateNote(); });
  input.addEventListener('focus', () => { open = true; draw(); });
  input.addEventListener('blur', () => { open = false; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Down') { e.preventDefault(); open = true; active = Math.min(shown.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp' || e.key === 'Up') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter' && open && shown[active]) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === 'Escape' || e.key === 'Esc') { open = false; draw(); }
  });
  loadDepartments().then((d) => { items = d; draw(); updateNote(); });
  return {
    el: h('div.dp', input, list),
    note,
    value: () => ({ department: input.value.trim(), department_id: id }),
  };
}

async function route() {
  const { parts, params } = parseHash();
  const page = parts[0] || '';
  window.scrollTo(0, 0);
  if (!me && !PUBLIC.includes(page)) { location.hash = '#/login'; return; }
  if (me && PUBLIC.includes(page)) { location.hash = '#/'; return; }
  try {
    if (page === 'login') renderLogin();
    else if (page === 'register') renderRegister();
    else if (page === 'verify') renderVerify(params.get('email') || '');
    else if (page === 'forgot') renderForgot();
    else if (page === 'pending') renderPending();
    else if (page === 'new') await renderNew();
    else if (page === 'tickets' && parts[1]) await renderTicket(Number(parts[1]));
    else if (page === 'profile') renderProfile();
    else await renderList(params.get('state') || 'open');
  } catch (e) {
    shell(h('div.empty-state', 'Не удалось загрузить: ' + e.message));
  }
}

// Оформление из настроек портала: название сайта заявок, логотип, предприятие
function brand() {
  const b = (cfg && cfg.brand) || {};
  return { helpdesk_title: b.helpdesk_title || 'HelpDesk', company: b.company || '', logoUrl: b.logo && b.helpdesk_logo !== false ? b.logo : null };
}

// ---------------- Каркас ----------------
function shell(...content) {
  const nav = [['', '#/', 'Мои заявки'], ['new', '#/new', 'Новая заявка'], ['profile', '#/profile', 'Профиль']];
  const cur = parseHash().parts[0] || '';
  clear(app,
    topbar({
      brandText: brand().helpdesk_title, brandHref: '#/', logo: 'hd', logoUrl: brand().logoUrl,
      nav, active: cur === 'tickets' ? '' : cur,
      actions: cur === 'new' ? [] : [h('a.btn.primary', { href: '#/new' }, '+ Новая заявка')],
      userName: me.full_name, userSub: me.department || me.email,
      menu: [{ label: 'Профиль', href: '#/profile' }, '-', { label: 'Выйти', onClick: logout }],
    }),
    h('div.layout', h('main.main.full', h('div.page', content))));
}

function authPage(title, ...content) {
  clear(app, h('div.login-page',
    h('div.login-brand', h('span.brand-logo.hd', logoStyle(brand().logoUrl), '?'), brand().helpdesk_title),
    brand().company ? h('div.muted', { style: { textAlign: 'center', margin: '-8px 0 12px' } }, brand().company) : null,
    h('div.login-card', { style: title === 'Регистрация' ? { width: '560px' } : {} },
      h('h1', title), content),
  ));
  setTimeout(() => app.querySelector('input')?.focus(), 30);
}

async function logout() {
  await api.post('/logout').catch(() => {});
  me = null;
  location.hash = '#/login';
}

const errBox = () => h('div.error-box.hidden');
const showErr = (box, e) => { box.textContent = e.message; box.classList.remove('hidden'); };

// ---------------- Вход и регистрация ----------------
function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: cfg.domains[0] ? 'ivanov@' + cfg.domains[0] : '' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = errBox();
  const btn = h('button.btn.primary', { type: 'submit' }, 'Войти');
  authPage('Вход',
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault(); btn.disabled = true; err.classList.add('hidden');
        try {
          await api.post('/login', { email: email.value, password: pass.value });
          me = await api.get('/me');
          location.hash = '#/';
        } catch (ex) {
          if (ex.data?.next === 'verify') { location.hash = '#/verify?email=' + encodeURIComponent(ex.data.email); return; }
          showErr(err, ex);
        } finally { btn.disabled = false; }
      },
    }, err,
    h('label.field', h('span', 'Рабочий e-mail'), email),
    h('label.field', h('span', 'Пароль'), pass),
    btn,
    h('div.row.wrap', { style: { justifyContent: 'space-between' } },
      h('a', { href: '#/register' }, 'Регистрация'),
      h('a', { href: '#/forgot' }, 'Забыли пароль?'))));
}

function renderRegister() {
  const f = {
    email: h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: cfg.domains[0] ? 'ivanov@' + cfg.domains[0] : 'ivanov@company.local' }),
    full_name: h('input', { type: 'text', required: true, autocomplete: 'name', placeholder: 'Иванов Иван Иванович' }),
    position: h('input', { type: 'text', placeholder: 'Бухгалтер' }),
    room: h('input', { type: 'text', placeholder: 'Каб. 101' }),
    phone: h('input', { type: 'tel', placeholder: 'внутр. 123' }),
    password: h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
  };
  const pass2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const dept = departmentPicker({});
  const err = errBox();
  const btn = h('button.btn.primary', { type: 'submit' }, 'Зарегистрироваться');
  authPage('Регистрация',
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        if (f.password.value !== pass2.value) { showErr(err, new Error('Пароли не совпадают')); return; }
        btn.disabled = true;
        try {
          const body = dept.value();
          Object.keys(f).forEach((k) => { body[k] = f[k].value; });
          const res = await api.post('/register', body);
          if (res.next === 'verify') location.hash = '#/verify?email=' + encodeURIComponent(res.email);
          else if (res.next === 'approval') location.hash = '#/pending';
          else { me = await api.get('/me'); toast('Добро пожаловать!'); location.hash = '#/new'; }
        } catch (ex) { showErr(err, ex); } finally { btn.disabled = false; }
      },
    }, err,
    cfg.domains.length ? h('div.info-box.small', 'Регистрация по рабочей почте: ', cfg.domains.map((d) => '@' + d).join(', ')) : null,
    h('label.field', h('span', 'Рабочий e-mail *'), f.email),
    h('label.field', h('span', 'ФИО *'), f.full_name),
    h('div.field', h('span.field-label', 'Отдел'), dept.el, dept.note),
    h('div.form-grid',
      h('label.field', h('span', 'Должность'), f.position),
      h('label.field', h('span', 'Кабинет'), f.room),
      h('label.field', h('span', 'Телефон'), f.phone),
      h('label.field', h('span', 'Пароль * (от 8 символов)'), f.password),
      h('label.field', h('span', 'Повторите пароль *'), pass2)),
    cfg.mailEnabled ? h('p.hint', 'На почту придёт код подтверждения.') : null,
    cfg.requireApproval ? h('p.hint', 'После регистрации служба ИТ подтвердит вашу учётную запись.') : null,
    btn,
    h('div', 'Уже зарегистрированы? ', h('a', { href: '#/login' }, 'Войти'))));
}

function renderVerify(email) {
  const code = h('input.code-input', { type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', required: true });
  const err = errBox();
  const btn = h('button.btn.primary', { type: 'submit' }, 'Подтвердить');
  authPage('Подтверждение e-mail',
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault(); btn.disabled = true; err.classList.add('hidden');
        try {
          const res = await api.post('/verify', { email, code: code.value });
          if (res.next === 'approval') { location.hash = '#/pending'; return; }
          me = await api.get('/me'); toast('Почта подтверждена'); location.hash = '#/new';
        } catch (ex) { showErr(err, ex); } finally { btn.disabled = false; }
      },
    }, err,
    h('p', 'Мы отправили 6-значный код на ', h('strong', email), '. Введите его ниже.'),
    code, btn,
    h('button.btn.subtle', { type: 'button', onclick: (e) => run(async () => { await api.post('/resend', { email }); toast('Код отправлен ещё раз'); }, e.currentTarget) }, 'Отправить код ещё раз')));
}

function renderPending() {
  authPage('Регистрация принята',
    h('div.stack',
      h('div.ok-box', 'Спасибо! Ваша учётная запись ждёт подтверждения службой ИТ.'),
      h('p.muted', 'Когда её подтвердят, вы сможете войти с указанными e-mail и паролем.'),
      h('a.btn', { href: '#/login' }, 'Ко входу')));
}

function renderForgot() {
  if (!cfg.mailEnabled) {
    authPage('Восстановление пароля', h('div.stack',
      h('div.info-box', 'Чтобы сменить пароль, обратитесь в службу ИТ — вам установят новый.'),
      h('a.btn', { href: '#/login' }, 'Ко входу')));
    return;
  }
  const email = h('input', { type: 'email', required: true });
  const code = h('input.code-input', { type: 'text', inputmode: 'numeric', maxlength: 6 });
  const pass = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password' });
  const step2 = h('div.stack.hidden', h('label.field', h('span', 'Код из письма'), code), h('label.field', h('span', 'Новый пароль (от 8 символов)'), pass));
  const err = errBox();
  const btn = h('button.btn.primary', { type: 'submit' }, 'Получить код');
  let sent = false;
  authPage('Восстановление пароля',
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault(); btn.disabled = true; err.classList.add('hidden');
        try {
          if (!sent) {
            await api.post('/forgot', { email: email.value });
            sent = true; step2.classList.remove('hidden'); btn.textContent = 'Сменить пароль'; email.disabled = true;
            toast('Если адрес зарегистрирован, на него отправлен код');
          } else {
            await api.post('/reset', { email: email.value, code: code.value, password: pass.value });
            toast('Пароль изменён. Войдите с новым паролем'); location.hash = '#/login';
          }
        } catch (ex) { showErr(err, ex); } finally { btn.disabled = false; }
      },
    }, err, h('label.field', h('span', 'Рабочий e-mail'), email), step2, btn, h('a', { href: '#/login' }, 'Ко входу')));
}

// ---------------- Мои заявки ----------------
async function renderList(state) {
  const [tickets] = await Promise.all([api.get('/tickets?state=' + state)]);
  const tabs = [['open', 'Открытые'], ['closed', 'Закрытые'], ['all', 'Все']];
  shell(
    h('div.page-head', h('h1', 'Мои заявки'), h('span.badge', String(tickets.length))),
    cfg.welcome ? h('p.muted', { style: { margin: '-8px 0 16px' } }, cfg.welcome) : null,
    h('div.tabs', tabs.map(([k, l]) => h('a.tab' + (k === state ? '.active' : ''), { href: '#/?state=' + k }, l))),
    tickets.length ? tickets.map((t) => h('a.tcard', { href: '#/tickets/' + t.id },
      h('div.tcard-top', h('span.ticket-key', '#' + t.id), statusPill(t.status_name, t.status_color),
        t.is_overdue ? h('span.lozenge.red', 'срок прошёл') : null),
      h('div.tcard-title', t.title),
      h('div.tcard-meta',
        h('span', (t.category_icon || '') + ' ' + (t.category_name || 'Без вида')),
        h('span', 'Создана ', fmtDateTime(t.created_at)),
        h('span', 'Исполнитель: ', t.assignee_name || 'ещё не назначен'),
        t.due_at ? h('span', 'Срок: ', fmtDateTime(t.due_at)) : null,
        h('span', 'Обновлена ', relTime(t.updated_at)))))
      : h('div.empty-state', state === 'open' ? 'Открытых заявок нет. ' : 'Заявок нет. ', h('a', { href: '#/new' }, 'Создать заявку')));
}

// ---------------- Новая заявка ----------------
async function renderNew() {
  const cats = await api.get('/categories');
  let catId = null;
  const catBtns = cats.map((c) => {
    const b = h('button.cat-opt', {
      type: 'button',
      onclick: () => { catId = c.id; catBtns.forEach((x) => x.classList.toggle('on', x === b)); if (!title.value) title.focus(); },
    }, h('span.ic', c.icon), h('div', h('div.t', c.name), c.description ? h('div.d', c.description) : null));
    return b;
  });
  const title = h('input', { type: 'text', maxlength: 200, required: true, placeholder: 'Например: не печатает принтер в бухгалтерии' });
  const desc = h('textarea', { rows: 6, placeholder: 'Что произошло, когда, какие сообщения об ошибке видите, что уже пробовали сделать' });
  const location_ = h('input', { type: 'text', value: me.room || '', placeholder: 'Кабинет / рабочее место' });
  const prio = h('select', Object.entries(cfg.priorities).map(([k, l]) => h('option', { value: k }, l)));
  prio.value = 'normal';
  const files = fileInput();
  const err = errBox();
  const btn = h('button.btn.primary', { type: 'submit' }, 'Отправить заявку');
  shell(h('div.page.narrow', { style: { padding: 0 } },
    h('h1', { style: { marginBottom: '16px' } }, 'Новая заявка'),
    h('form.panel.stack', {
      onsubmit: async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        if (cats.length && !catId) { showErr(err, new Error('Выберите, что случилось')); window.scrollTo(0, 0); return; }
        btn.disabled = true;
        try {
          const fd = new FormData();
          if (catId) fd.append('category_id', catId);
          fd.append('title', title.value);
          fd.append('description', desc.value);
          fd.append('location', location_.value);
          fd.append('priority', prio.value);
          files.files().forEach((f) => fd.append('files', f));
          const { id } = await api.post('/tickets', fd);
          toast(`Заявка #${id} отправлена`);
          location.hash = '#/tickets/' + id;
        } catch (ex) { showErr(err, ex); } finally { btn.disabled = false; }
      },
    }, err,
    cats.length ? [h('div.field', h('span', 'Что случилось? *')), h('div.cat-grid', catBtns)] : null,
    h('label.field', h('span', 'Тема *'), title),
    h('label.field', h('span', 'Подробное описание'), desc),
    h('div.form-grid',
      h('label.field', h('span', 'Где находится (кабинет, рабочее место)'), location_),
      h('label.field', h('span', 'Срочность'), prio, h('span.hint', 'Срок выполнения назначит служба ИТ'))),
    files.el,
    h('p.hint', 'Приложите фото или скриншот ошибки — так проблему решат быстрее.'),
    h('div.row', btn, h('a.btn.subtle', { href: '#/' }, 'Отмена')))));
}

// ---------------- Заявка ----------------
async function renderTicket(id) {
  const [t, sts] = await Promise.all([api.get('/tickets/' + id), statuses.length ? statuses : api.get('/statuses')]);
  statuses = sts;
  const body = h('textarea', { placeholder: t.is_closed ? 'Заявка закрыта. Если проблема осталась — напишите, служба ИТ увидит сообщение.' : 'Уточнение, ответ на вопрос службы ИТ…' });
  const files = fileInput();
  const send = h('button.btn.primary', {
    onclick: () => run(async () => {
      const fd = new FormData();
      fd.append('body', body.value);
      files.files().forEach((f) => fd.append('files', f));
      await api.post(`/tickets/${id}/comments`, fd);
      toast('Сообщение отправлено');
      renderTicket(id);
    }, send),
  }, 'Отправить');

  // Ход выполнения: открытые статусы по порядку, затем закрытие
  const open = statuses.filter((s) => !s.is_closed);
  const curIdx = open.findIndex((s) => s.name === t.status_name);
  const steps = [...open.map((s, i) => ({ label: s.name, done: t.is_closed || i < curIdx, cur: !t.is_closed && i === curIdx })),
    { label: t.is_closed ? t.status_name : 'Закрыта', done: false, cur: t.is_closed }];

  const topFiles = t.attachments.filter((a) => !a.comment_id);
  shell(h('div.issue',
    h('div.stack',
      h('div', h('a', { href: '#/' }, '← Мои заявки')),
      h('div.panel',
        h('div.row.wrap', h('span.ticket-key', 'Заявка #' + t.id), statusPill(t.status_name, t.status_color),
          t.is_overdue ? h('span.lozenge.red', 'срок прошёл') : null),
        h('h1', { style: { marginTop: '8px' } }, t.title),
        h('div.pstep-line', steps.map((s) => h('div.pstep' + (s.done ? '.done' : '') + (s.cur ? '.cur' : ''), s.label))),
        h('div.ticket-desc', t.description || h('span.muted', 'Без описания')),
        fileList(topFiles, fileUrl)),
      h('div.panel',
        h('h3', 'Переписка со службой ИТ'),
        thread(t.comments, t.attachments, { urlFor: fileUrl }),
        h('div.reply', body, files.el, h('div.row', h('span.spacer'), send)))),
    h('div.side-panel',
      h('div.panel',
        h('dl.kv',
          h('dt', 'Статус'), h('dd', statusPill(t.status_name, t.status_color)),
          h('dt', 'Вид проблемы'), h('dd', (t.category_icon || '') + ' ' + (t.category_name || '—')),
          h('dt', 'Срочность'), h('dd', cfg.priorities[t.priority]),
          h('dt', 'Исполнитель'), h('dd', t.assignee_name || h('span.muted', 'ещё не назначен')),
          h('dt', 'Срок выполнения'), h('dd' + (t.is_overdue ? '.overdue' : ''), t.due_at ? fmtDateTime(t.due_at) : h('span.muted', 'назначит служба ИТ')),
          h('dt', 'Место'), h('dd', t.location || '—'),
          h('dt', 'Создана'), h('dd', fmtDateTime(t.created_at)),
          t.closed_at ? [h('dt', 'Закрыта'), h('dd', fmtDateTime(t.closed_at))] : null)),
      t.history.length ? h('div.panel', h('h3', 'Ход выполнения'), historyList(t.history)) : null)));
}

// ---------------- Профиль ----------------
function renderProfile() {
  const f = {};
  const field = (k, label, type = 'text') => { f[k] = h('input', { type, value: me[k] || '' }); return h('label.field', h('span', label), f[k]); };
  const dept = departmentPicker(me);
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = dept.value();
      Object.keys(f).forEach((k) => { body[k] = f[k].value; });
      me = { ...me, ...(await api.patch('/me', body)) };
      toast('Профиль сохранён'); renderProfile();
    }, save),
  }, 'Сохранить');
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const savePw = h('button.btn', {
    onclick: () => run(async () => {
      if (next.value !== next2.value) throw new Error('Пароли не совпадают');
      await api.post('/me/password', { current: cur.value, next: next.value });
      cur.value = next.value = next2.value = '';
      toast('Пароль изменён');
    }, savePw),
  }, 'Сменить пароль');
  shell(h('div.page.narrow.stack', { style: { padding: 0 } },
    h('h1', 'Профиль'),
    h('div.panel.stack',
      h('div.muted', 'E-mail: ', h('strong', me.email)),
      field('full_name', 'ФИО'),
      h('div.field', h('span.field-label', 'Отдел'), dept.el, dept.note),
      h('div.form-grid', field('position', 'Должность'), field('room', 'Кабинет'), field('phone', 'Телефон', 'tel')),
      h('div', save)),
    h('div.panel.stack',
      h('h3', 'Смена пароля'),
      h('label.field', h('span', 'Текущий пароль'), cur),
      h('div.form-grid', h('label.field', h('span', 'Новый пароль (от 8 символов)'), next), h('label.field', h('span', 'Повторите'), next2)),
      h('div', savePw))));
}

boot().catch((e) => { app.textContent = 'Ошибка загрузки: ' + e.message; });
