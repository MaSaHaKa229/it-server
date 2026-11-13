// Колокольчик уведомлений в шапке портала (все разделы: портал, инвентарь, заявки, календарь, документы).
// Самостоятельный модуль без зависимостей: календарь и документы (React) подключают его динамически.
// Уведомления двух видов: события (новая заявка, назначили задачу…) — их можно прочитать,
// и состояния (срок, расходники, гарантия…) — висят, пока не решены. Настройки — у каждого свои.

const STYLE = `
.nb-wrap { position: relative; display: inline-flex; margin-right: 6px; }
.nb-btn { position: relative; width: 34px; height: 34px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: var(--n500,#42526E); display: inline-grid; place-items: center; }
.nb-btn:hover { background: var(--n20,#F4F5F7); color: var(--n800,#172B4D); }
.nb-count { position: absolute; top: 1px; right: 0; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--r400,#DE350B); color: #fff; font: 700 10px/16px -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
.nb-count.warn { background: var(--y500,#FF8B00); }
.nb-pop { position: absolute; right: 0; top: 40px; z-index: 500; width: 420px; max-height: 75vh; display: flex; flex-direction: column; background: var(--n0,#fff); border-radius: 3px;
  box-shadow: 0 8px 16px -4px rgba(9,30,66,.25), 0 0 1px rgba(9,30,66,.31); font: 14px/20px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: var(--n800,#172B4D); text-align: left; }
.nb-pop[hidden] { display: none; }
.nb-scroll { overflow: auto; flex: 1; }
.nb-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--n30,#EBECF0); font-weight: 600; }
.nb-head button, .nb-foot button { border: 0; background: none; color: var(--b400,#0052CC); cursor: pointer; padding: 0; font: inherit; font-weight: 400; font-size: 13px; }
.nb-head button:hover, .nb-foot button:hover { text-decoration: underline; }
.nb-sec { padding: 8px 14px 4px; font-size: 11px; font-weight: 700; color: var(--n200,#6B778C); text-transform: uppercase; letter-spacing: .03em; }
.nb-item { display: block; padding: 8px 14px; border-left: 3px solid transparent; color: inherit; text-decoration: none; cursor: pointer; }
.nb-item.warning { border-left-color: var(--y500,#FF8B00); }
.nb-item.critical { border-left-color: var(--r400,#DE350B); }
.nb-item.unread { border-left-color: var(--b400,#0052CC); background: var(--hl-bg,#F4F8FF); }
.nb-item.read { color: var(--n200,#6B778C); }
.nb-item:hover { background: var(--n20,#F4F5F7); text-decoration: none; }
.nb-item b { display: block; font-weight: 600; }
.nb-item.read b { font-weight: 400; }
.nb-item small { display: block; color: var(--n200,#6B778C); white-space: pre-line; max-height: 60px; overflow: hidden; }
.nb-item time { float: right; font-size: 12px; color: var(--n200,#97A0AF); margin-left: 8px; }
.nb-bar { height: 6px; border-radius: 3px; background: var(--n30,#EBECF0); margin: 4px 0 2px; overflow: hidden; }
.nb-bar > i { display: block; height: 100%; background: var(--y500,#FF8B00); }
.nb-item.critical .nb-bar > i { background: var(--r400,#DE350B); }
.nb-empty { padding: 16px 14px; color: var(--n200,#6B778C); }
.nb-foot { display: flex; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--n30,#EBECF0); background: var(--n10,#FAFBFC); }
.nb-foot button:disabled { color: var(--n200,#6B778C); cursor: default; text-decoration: none; }
.nb-modal-bg { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(9,30,66,.54); z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding-top: 60px; }
.nb-modal { background: var(--n0,#fff); border-radius: 3px; width: 640px; max-height: 85vh; overflow: auto; box-shadow: 0 8px 16px -4px rgba(9,30,66,.25); font: 14px/20px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: var(--n800,#172B4D); }
.nb-modal h2 { margin: 0; padding: 18px 22px 8px; font-size: 20px; font-weight: 500; }
.nb-modal .nb-x { float: right; border: 0; background: none; font-size: 22px; cursor: pointer; color: var(--n200,#6B778C); margin: -4px -6px 0 0; }
.nb-modal table { width: 100%; border-collapse: collapse; margin: 6px 0; }
.nb-modal th { text-align: left; font-size: 12px; color: var(--n200,#6B778C); font-weight: 600; padding: 6px 22px; border-bottom: 2px solid var(--n40,#DFE1E6); }
.nb-modal th.c, .nb-modal td.c { text-align: center; width: 90px; padding-left: 4px; padding-right: 4px; }
.nb-modal td { padding: 6px 22px; border-bottom: 1px solid var(--n30,#EBECF0); }
.nb-modal tr.grp td { font-weight: 700; color: var(--n500,#42526E); background: var(--n10,#FAFBFC); padding-top: 8px; }
.nb-modal p { margin: 4px 22px 10px; color: var(--n200,#6B778C); font-size: 13px; }
.nb-modal .nb-ok { display: flex; justify-content: flex-end; padding: 10px 22px 18px; }
.nb-modal .nb-ok button { background: var(--b400,#0052CC); color: #fff; border: 0; border-radius: 3px; padding: 6px 14px; font: inherit; cursor: pointer; }
`;

const BELL_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function style() {
  if (document.getElementById('nb-style')) return;
  const st = el('style'); st.id = 'nb-style'; st.textContent = STYLE; document.head.append(st);
}

async function call(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'portal' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error((d && d.error) || `Ошибка ${r.status}`);
  return d;
}

export const getNotifications = () => call('GET', '/api/notifications');
export const setNotifySetting = (key, value) => call('PUT', '/api/notifications/settings', { [key]: value });
export const markRead = (ids) => call('POST', '/api/notifications/read', ids === 'all' ? { all: true } : { ids });

const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};

/** Пункт уведомления (используется и на главной странице) */
export function itemEl(x, onOpen) {
  style();
  const isEvent = x.id != null;
  const a = el('a', 'nb-item ' + (isEvent ? (x.read ? 'read' : 'unread') : (x.level || 'warning')));
  if (x.link) a.href = x.link;
  if (isEvent) a.append(el('time', '', fmt(x.at)));
  a.append(el('b', '', x.title));
  if (x.percent != null) {
    const bar = el('div', 'nb-bar'); const fill = el('i'); fill.style.width = `${Math.max(2, x.percent)}%`; bar.append(fill); a.append(bar);
  }
  if (x.text) a.append(el('small', '', x.text));
  a.addEventListener('click', () => { if (isEvent && !x.read) markRead([x.id]).catch(() => {}); if (onOpen) onOpen(x); });
  return a;
}

/** Окно настроек: для каждого вида — «на сайте» и «на почту» */
export async function openNotifySettings() {
  style();
  const d = await getNotifications();
  const bg = el('div', 'nb-modal-bg');
  const box = el('div', 'nb-modal');
  const x = el('button', 'nb-x', '×'); x.type = 'button';
  const h = el('h2', '', 'Настройки уведомлений'); h.prepend(x);
  box.append(h);
  const mailOk = d.mail.enabled && d.mail.email;
  box.append(el('p', '', mailOk
    ? `Письма приходят на ${d.mail.email}. Изменения сохраняются сразу.`
    : d.mail.enabled ? 'Письма не приходят: в вашей учётной записи не указан e-mail (его задаёт администратор портала).'
      : 'Почта не настроена администратором портала — доступны только уведомления на сайте.'));
  const t = el('table');
  const hr = el('tr'); hr.append(el('th', '', 'Уведомление'), el('th', 'c', 'На сайте'), el('th', 'c', 'На почту'));
  t.append(hr);
  let group = '';
  for (const k of d.kinds) {
    if (k.group !== group) {
      group = k.group;
      const g = el('tr', 'grp'); const td = el('td', '', group); td.colSpan = 3; g.append(td); t.append(g);
    }
    const tr = el('tr');
    const label = el('td', '', k.label);
    const mk = (field, disabled) => {
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!k[field]; cb.disabled = disabled;
      cb.addEventListener('change', async () => {
        try { await setNotifySetting(k.key, { [field]: cb.checked }); k[field] = cb.checked; } catch (e) { cb.checked = !cb.checked; alert(e.message); }
      });
      const td = el('td', 'c'); td.append(cb); return td;
    };
    tr.append(label, mk('site', false), mk('email', !mailOk));
    t.append(tr);
  }
  box.append(t);
  const th = d.thresholds || {};
  box.append(el('p', '', `Сроки: заявки — за ${th.hd_due_hours ?? 24} ч, задачи — накануне, гарантия и лицензии — за ${th.warranty_days ?? 30} дн. `
    + `(поля-даты техники и ПО со словами «гарантия», «лицензия», «срок»…), «не в сети» — дольше ${th.offline_days ?? 30} дн., `
    + `расходники — меньше ${d.supply_threshold ?? 15}%. Пороги задаёт администратор портала.`));
  const ok = el('div', 'nb-ok'); const okb = el('button', '', 'Готово'); okb.type = 'button'; ok.append(okb); box.append(ok);
  bg.append(box);
  const close = () => { bg.remove(); document.dispatchEvent(new CustomEvent('nb-changed')); };
  x.addEventListener('click', close); okb.addEventListener('click', close);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
}

/** Колокольчик в элемент host (обычно — шапка рядом с именем пользователя) */
export function mountBell(host) {
  style();
  const wrap = el('span', 'nb-wrap');
  const btn = el('button', 'nb-btn');
  btn.type = 'button'; btn.title = 'Уведомления'; btn.innerHTML = BELL_SVG;
  const count = el('span', 'nb-count'); count.hidden = true;
  btn.append(count);
  const pop = el('div', 'nb-pop'); pop.hidden = true;
  wrap.append(btn, pop);
  host.append(wrap);
  let data = null;

  const setCount = (n, critical) => {
    count.hidden = !n;
    count.textContent = n > 99 ? '99+' : String(n);
    count.className = 'nb-count' + (critical ? '' : ' warn');
    btn.title = n ? `Уведомления: ${n}` : 'Уведомления';
  };

  const render = () => {
    pop.replaceChildren();
    const head = el('div', 'nb-head', 'Уведомления');
    if (data && data.events.some((x) => !x.read)) {
      const all = el('button', '', 'Отметить все прочитанными'); all.type = 'button';
      all.addEventListener('click', async () => { await markRead('all').catch(() => {}); await load(true); });
      head.append(all);
    }
    pop.append(head);
    const sc = el('div', 'nb-scroll'); pop.append(sc);
    if (!data) { sc.append(el('div', 'nb-empty', 'Загрузка…')); return; }
    const close = () => { pop.hidden = true; };
    const unread = data.events.filter((x) => !x.read);
    const read = data.events.filter((x) => x.read);
    if (!data.states.length && !data.events.length) sc.append(el('div', 'nb-empty', 'Новых уведомлений нет.'));
    if (unread.length) { sc.append(el('div', 'nb-sec', 'Новые')); unread.forEach((x) => sc.append(itemEl(x, close))); }
    if (data.states.length) { sc.append(el('div', 'nb-sec', 'Требуют внимания')); data.states.forEach((x) => sc.append(itemEl(x, close))); }
    if (read.length) { sc.append(el('div', 'nb-sec', 'Прочитанные')); read.slice(0, 20).forEach((x) => sc.append(itemEl(x, close))); }
    const foot = el('div', 'nb-foot');
    const set = el('button', '', 'Настройки уведомлений'); set.type = 'button';
    set.addEventListener('click', () => { pop.hidden = true; openNotifySettings().catch((e) => alert(e.message)); });
    foot.append(set);
    const sup = data.kinds.find((k) => k.key === 'printer_supplies');
    if (data.canRefresh && sup && sup.site) {
      const r = el('button', '', 'Проверить принтеры сейчас'); r.type = 'button';
      r.addEventListener('click', async () => {
        r.disabled = true; r.textContent = 'Опрашиваю принтеры…';
        try { await call('POST', '/api/notifications/refresh'); await load(true); } catch (e) { alert(e.message); }
        r.disabled = false; r.textContent = 'Проверить принтеры сейчас';
      });
      foot.append(r);
    }
    pop.append(foot);
  };

  async function load(full) {
    try {
      if (full || !pop.hidden) {
        data = await getNotifications();
        setCount(data.unread, data.states.some((x) => x.level === 'critical') || data.events.some((x) => !x.read));
        if (!pop.hidden) render();
      } else {
        const c = await call('GET', '/api/notifications/count');
        setCount(c.unread, c.critical);
      }
    } catch { /* нет связи — попробуем позже */ }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); pop.hidden = !pop.hidden;
    if (!pop.hidden) { render(); load(true); }
  });
  const outside = (e) => { if (!wrap.contains(e.target)) pop.hidden = true; };
  document.addEventListener('click', outside);
  const changed = () => load(true);
  document.addEventListener('nb-changed', changed);
  load(false);
  const timer = setInterval(() => load(false), 60 * 1000);
  return () => { clearInterval(timer); document.removeEventListener('click', outside); document.removeEventListener('nb-changed', changed); wrap.remove(); };
}

/** Общий поиск по порталу + колокольчик (всё, что справа в шапке рядом с именем) */
// Раздел инструкции по адресу страницы
function helpHref() {
  const p = location.pathname;
  const sec = p.startsWith('/inventory') ? 'inventory' : p.startsWith('/helpdesk') ? 'helpdesk' : p.startsWith('/calendar') ? 'calendar'
    : p.startsWith('/docs') ? 'docs' : p.startsWith('/admin') ? 'admin' : '';
  return '/help' + (sec ? '#' + sec : '');
}

export function mountHeaderTools(host) {
  if (location.pathname !== '/help') {
    const q = document.createElement('a');
    q.href = helpHref(); q.title = 'Инструкция по этому разделу'; q.textContent = '?';
    q.setAttribute('style', 'width:28px;height:28px;margin-right:6px;border:1.5px solid var(--n200,#6B778C);border-radius:50%;display:inline-grid;'
      + 'place-items:center;color:var(--n500,#42526E);font-weight:700;font-size:14px;text-decoration:none;line-height:1');
    q.addEventListener('mouseenter', () => { q.style.background = 'var(--n20,#F4F5F7)'; });
    q.addEventListener('mouseleave', () => { q.style.background = ''; });
    host.append(q);
  }
  const s = document.createElement('span');
  host.append(s);
  import('./search.js').then((m) => m.mountSearch(s)).catch(() => {});
  const r = document.createElement('span');
  host.append(r);
  import('./recent.js').then((m) => m.mountRecent(r)).catch(() => {});
  import('./peek.js').then((m) => m.initPeek()).catch(() => {});
  return mountBell(host);
}
