// Мини-библиотека для страниц портала и helpdesk (без внешних зависимостей)

/** Создать элемент: h('div.card#id', {attrs}, ...children) */
export function h(tag, ...args) {
  const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const a of args) add(el, a);
  // value применяем в конце, когда у <select> уже есть варианты
  if ('_value' in el) { el.value = el._value; delete el._value; }
  return el;
}
function add(el, a) {
  if (a == null || a === false) return;
  if (Array.isArray(a)) { a.forEach((x) => add(el, x)); return; }
  if (a instanceof Node) { el.append(a); return; }
  if (typeof a === 'object') {
    for (const [k, v] of Object.entries(a)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el._value = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    return;
  }
  el.append(String(a));
}
export const clear = (el, ...children) => { el.replaceChildren(); children.forEach((c) => add(el, c)); return el; };

// ---------- API ----------
export function makeApi(base, { onUnauthorized, csrf = 'portal' } = {}) {
  async function call(method, url, body) {
    const opt = { method, headers: { 'X-Requested-With': csrf }, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url.startsWith('/') && !url.startsWith(base) ? base + url : url, opt);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : null;
    if (res.status === 401 && onUnauthorized) onUnauthorized(data);
    if (!res.ok) {
      const e = new Error((data && data.error) || `Ошибка ${res.status}`);
      e.status = res.status; e.data = data;
      throw e;
    }
    return data;
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b ?? {}),
    put: (u, b) => call('PUT', u, b ?? {}),
    patch: (u, b) => call('PATCH', u, b ?? {}),
    del: (u) => call('DELETE', u),
  };
}

// ---------- уведомления ----------
// Как в ИТ-инвентаре: «флажки» в левом нижнем углу
export function toast(text, type = 'ok', title) {
  let box = document.getElementById('flags');
  if (!box) { box = h('div#flags.flags'); document.body.append(box); }
  const el = h('div.flag.' + type,
    h('div.ic', type === 'ok' ? '✓' : type === 'err' ? '!' : 'i'),
    h('div', title || type === 'err' ? h('div.t', title || 'Ошибка') : null, h('div', text)));
  box.append(el);
  el.addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 4000);
}
/** Выполнить действие, показать ошибку, заблокировать кнопку на время */
export async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message || String(e), 'err'); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ---------- модальные окна ----------
export function modal({ title, body, footer = [], wide = false, narrow = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div.modal' + (wide ? '.wide' : narrow ? '.narrow' : ''), { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', h('h2', title), h('button.btn.subtle.icon', { type: 'button', title: 'Закрыть', onclick: close }, '✕')),
    h('div.modal-body', body),
    footer.length ? h('div.modal-foot', footer) : null);
  const back = h('div.modal-backdrop', { onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', esc);
  setTimeout(() => box.querySelector('input:not([type=checkbox]):not([disabled]),select,textarea')?.focus(), 30);
  return { close, el: box };
}
export function confirmDialog(title, text, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, narrow: true, body: h('p', text),
      footer: [
        h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'),
        h('button.btn.danger', { onclick: () => { done = true; m.close(); } }, okLabel),
      ],
      onClose: () => resolve(done),
    });
  });
}

// ---------- форматирование ----------
export const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');
// Явные поля (не dateStyle/timeStyle) — одинаково во всех браузерах, включая Firefox 52
export const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '');
export function fmtSize(b) {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}
export function relTime(v) {
  if (!v) return '';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} дн назад`;
  return fmtDate(v);
}
/** Значение для <input type=datetime-local> */
export function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
}
// Те же цвета и расчёт, что в ИТ-инвентаре: у человека одинаковый аватар во всех разделах
const AV_COLORS = ['#0052CC', '#00875A', '#FF5630', '#6554C0', '#00A3BF', '#FF8B00', '#36B37E', '#5243AA'];
export function avatar(name, size = '') {
  const n = String(name || '?');
  let sum = 0; for (const ch of n) sum += ch.charCodeAt(0);
  const ini = n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  return h('span.avatar' + (size ? '.' + size : ''), { style: { background: AV_COLORS[sum % AV_COLORS.length] }, title: n }, ini || '?');
}
export const statusPill = (name, color) => h('span.pill', { style: { background: color + '26', color: shade(color) } }, name);
// Цвет текста на светлой плашке — немного темнее исходного
function shade(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const f = (v) => Math.round(v * 0.75).toString(16).padStart(2, '0');
  return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

/** Простой роутер по hash: #/path/1?x=y */
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}

// ---------- шапка в стиле ИТ-инвентаря ----------
/**
 * topbar({ section, sectionHref, nav: [[key, href, label]], active, actions: [nodes],
 *          userName, userSub, menu: [{label, href|onClick, danger} | '-' | {head}], logo, brandText, brandHref, onBurger })
 */
export function topbar(o) {
  const menuEl = h('div.popover.hidden');
  const closeMenu = () => menuEl.classList.add('hidden');
  document.addEventListener('click', (e) => { if (!menuEl.contains(e.target)) closeMenu(); });
  const fill = () => clear(menuEl,
    h('div.menu-head', o.userName + (o.userSub ? ' · ' + o.userSub : '')),
    (o.menu || []).map((it) => {
      if (it === '-') return h('div.menu-sep');
      if (it.head) return h('div.menu-head', it.head);
      return it.href
        ? h('a.menu-item' + (it.danger ? '.danger' : ''), { href: it.href, target: it.target }, it.label)
        : h('button.menu-item' + (it.danger ? '.danger' : ''), { type: 'button', onclick: () => { closeMenu(); it.onClick(); } }, it.label);
    }));
  const av = avatar(o.userName);
  av.addEventListener('click', (e) => { e.stopPropagation(); fill(); menuEl.classList.toggle('hidden'); });
  return h('header.topbar',
    o.onBurger ? h('button.btn.subtle.icon.burger', { onclick: o.onBurger, title: 'Меню' }, '☰') : null,
    h('a.brand', { href: o.brandHref || '/', title: 'Главная страница портала' },
      h('span.brand-logo' + (o.logo === 'hd' ? '.hd' : ''), o.logo === 'hd' ? '?' : 'IT'), h('span', o.brandText || 'Портал')),
    o.section ? h('a.brand', { href: o.sectionHref || '#/', style: { marginLeft: '-12px' } }, h('span.sep', '/'), h('span', o.section)) : null,
    h('nav.topnav.row', { style: { gap: '2px' } },
      (o.nav || []).map(([k, href, label]) => h('a' + (k === o.active ? '.active' : ''), { href }, label))),
    (o.actions || []).length ? h('span.row', { style: { marginLeft: '8px' } }, o.actions) : null,
    h('span.spacer'),
    h('span.user-name', o.userName),
    h('span.user-wrap', av, menuEl));
}

// ---------- сортировка таблиц ----------
/**
 * Заголовок таблицы с сортировкой по клику.
 * cols: [{ key, label, value?: (row) => any, sortable?: false }], state: { key, dir: 1 | -1 }, onSort()
 */
export function sortHead(cols, state, onSort) {
  return h('thead', h('tr', cols.map((c) => {
    if (c.sortable === false || !c.key) return h('th', c.label || '');
    const on = state.key === c.key;
    return h('th.sortable', {
      title: 'Сортировать',
      onclick: () => { state.dir = on ? -state.dir : 1; state.key = c.key; onSort(); },
    }, c.label, on ? h('span.arrow', state.dir > 0 ? '↑' : '↓') : null);
  })));
}
export function sortRows(rows, cols, state) {
  const col = cols.find((c) => c.key === state.key);
  if (!col) return rows;
  const get = col.value || ((r) => r[col.key]);
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    const ex = x === null || x === undefined || x === '', ey = y === null || y === undefined || y === '';
    if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1; // пустые значения — всегда в конце
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * state.dir;
    return String(x).localeCompare(String(y), 'ru', { numeric: true, sensitivity: 'base' }) * state.dir;
  });
}
/** Запомнить сортировку таблицы в браузере */
export function savedSort(key, def) {
  let st = def;
  try { st = { ...def, ...JSON.parse(localStorage.getItem('sort:' + key) || '{}') }; } catch { /* по умолчанию */ }
  return new Proxy(st, { set(t, k, v) { t[k] = v; try { localStorage.setItem('sort:' + key, JSON.stringify(t)); } catch { /* не страшно */ } return true; } });
}
