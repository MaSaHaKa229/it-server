// Общие UI-утилиты: построение DOM, API, модальные окна, всплывающие меню, комбобоксы
// ------------------------------------------------------------------------------

/** h('div.a.b#id', {attrs/props/on*}, ...children) */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'selected', 'disabled', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

// ---------- Иконки (SVG, в стиле Atlassian) ----------
const P = {
  search: 'M16.4 15l4.3 4.3a1 1 0 0 1-1.4 1.4L15 16.4A7 7 0 1 1 16.4 15zM10 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  plus: 'M13 11V6a1 1 0 0 0-2 0v5H6a1 1 0 0 0 0 2h5v5a1 1 0 0 0 2 0v-5h5a1 1 0 0 0 0-2h-5z',
  chevron: 'M8.3 10.3a1 1 0 0 1 1.4 0L12 12.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 0 1 0-1.4z',
  close: 'M12 10.6l4.3-4.3a1 1 0 1 1 1.4 1.4L13.4 12l4.3 4.3a1 1 0 0 1-1.4 1.4L12 13.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L10.6 12 6.3 7.7a1 1 0 0 1 1.4-1.4z',
  check: 'M6.7 11.3a1 1 0 0 0-1.4 1.4l3.5 3.5a1 1 0 0 0 1.4 0l8.5-8.5a1 1 0 0 0-1.4-1.4L9.5 14.1z',
  more: 'M5 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
  download: 'M13 12.6V5a1 1 0 0 0-2 0v7.6l-2.3-2.3a1 1 0 1 0-1.4 1.4l4 4a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0-1.4-1.4zM5 18a1 1 0 0 0 0 2h14a1 1 0 0 0 0-2z',
  columns: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm2 1v12h3V6zm5 0v12h2V6zm4 0v12h3V6z',
  edit: 'M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm14.7-7.5a.7.7 0 0 0 0-1l-2.4-2.4a.7.7 0 0 0-1 0l-1.3 1.3 2.8 2.8z',
  trash: 'M9 4h6a1 1 0 0 1 1 1v1h3a1 1 0 0 1 0 2h-1v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8H5a1 1 0 0 1 0-2h3V5a1 1 0 0 1 1-1zm1 2h4V6h-4zM8 8v11h8V8z',
  eye: 'M12 18c-4 0-7-3-8.5-6C5 9 8 6 12 6s7 3 8.5 6C19 15 16 18 12 18zm0-2a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-2a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
  copy: 'M10 4h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2V6a2 2 0 0 1 2-2zm0 4h4a2 2 0 0 1 2 2v4h2V6h-8zm-4 2v8h8v-8z',
  filter: 'M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 .8 1.6L14 13.4V19a1 1 0 0 1-1.4.9l-2-1A1 1 0 0 1 10 18v-4.6L4.2 6.6A1 1 0 0 1 4 6z',
  star: 'M12 17.3l-5 3 1.3-5.7L4 10.8l5.8-.5L12 5l2.2 5.3 5.8.5-4.3 3.8 1.3 5.7z',
  menu: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z',
  dashboard: 'M4 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm9 0a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1zm0 7a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1zm-9 3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  list: 'M5 6h2v2H5zm4 0h10v2H9zm-4 5h2v2H5zm4 0h10v2H9zm-4 5h2v2H5zm4 0h10v2H9z',
  book: 'M6 4h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zm1 2v11.2A2 2 0 0 1 7 17h9V6zm0 13h9v-.1H7z',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-1.6l-1.5-.9a7 7 0 0 0 0-1l1.5-.9a1 1 0 0 0 .4-1.3l-1.6-2.7a1 1 0 0 0-1.3-.4l-1.5.9a7 7 0 0 0-.9-.5V5a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v1.6a7 7 0 0 0-.9.5l-1.5-.9a1 1 0 0 0-1.3.4L3.7 9.3a1 1 0 0 0 .4 1.3l1.5.9a7 7 0 0 0 0 1l-1.5.9a1 1 0 0 0-.4 1.3l1.6 2.7a1 1 0 0 0 1.3.4l1.5-.9a7 7 0 0 0 .9.5V19a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1.6a7 7 0 0 0 .9-.5l1.5.9a1 1 0 0 0 1.3-.4l1.6-2.7a1 1 0 0 0-.4-1.3z',
  users: 'M9 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm7 1a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5zM3 18c0-2.8 2.7-5 6-5s6 2.2 6 5v1H3zm13.5-4.9c2.5.2 4.5 1.9 4.5 4.1V19h-4v-1c0-1.9-.2-3.4-.5-4.9z',
  lock: 'M8 10V8a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zm2 0h4V8a2 2 0 1 0-4 0z',
  screen: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H6a2 2 0 0 1-2-2zm2 0v9h12V5z',
  box: 'M12 3l8 4v10l-8 4-8-4V7zm0 2.2L6.5 8 12 10.8 17.5 8zM6 9.6v6.2l5 2.5v-6.2zm7 8.7l5-2.5V9.6l-5 2.5z',
};
export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || ''); p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd');
  s.append(p);
  return s;
}

// ---------- API ----------
export class ApiError extends Error {}
// Инвентарь работает внутри портала по адресу /inventory/
export const API_BASE = '/inventory';
export async function api(method, url, body) {
  if (url.startsWith('/api/')) url = API_BASE + url;
  const opt = { method, headers: { 'X-Requested-With': 'itdb' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (res.status === 401) {
    window.dispatchEvent(new Event('itdb:unauthorized'));
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Ошибка ${res.status}`);
  return data;
}
api.get = (u) => api('GET', u);
api.post = (u, b) => api('POST', u, b ?? {});
api.put = (u, b) => api('PUT', u, b ?? {});
api.patch = (u, b) => api('PATCH', u, b ?? {});
api.del = (u) => api('DELETE', u);

// ---------- Уведомления ----------
export function toast(text, type = 'ok', title) {
  const box = document.getElementById('flags');
  const el = h('div.flag.' + type,
    h('div.ic', type === 'ok' ? '✓' : type === 'err' ? '!' : 'i'),
    h('div', title ? h('div.t', title) : null, h('div', text)));
  box.append(el);
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 4000);
  el.addEventListener('click', () => el.remove());
}
export const toastError = (e) => toast(e.message || String(e), 'err', 'Ошибка');

/** Обёртка: выполнить async-действие, показать ошибку */
export async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toastError(e); } finally { if (btn) btn.disabled = false; }
}

// ---------- Модальные окна ----------
export function modal({ title, body, footer, size = '', onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.popover')) close(); };
  const box = h('div.modal' + (size ? '.' + size : ''), { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', h('h2', title), h('button.btn.subtle.icon', { onclick: close, title: 'Закрыть' }, icon('close'))),
    h('div.modal-body', body),
    footer ? h('div.modal-foot', footer) : null);
  const back = h('div.modal-backdrop', { onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  setTimeout(() => { // Поле-комбобокс не фокусируем автоматически: иначе его список сразу раскрывается поверх формы
    if (box.contains(document.activeElement)) return; // фокус уже поставил сам компонент
    const f = [...box.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea')].find((x) => !x.closest('.combo')); f && f.focus(); }, 30);
  return { close, el: box };
}

export function confirmDialog({ title, text, okText = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const ok = h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => { done = true; m.close(); resolve(true); } }, okText);
    const m = modal({
      title, size: 'narrow', body: h('p', text),
      footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), ok],
      onClose: () => { if (!done) resolve(false); },
    });
    setTimeout(() => ok.focus(), 40);
  });
}

// ---------- Всплывающие панели ----------
let openPop = null;
export function closePopover() { if (openPop) { openPop.close(); openPop = null; } }
export function popover(anchor, content, { width, align = 'left', onClose } = {}) {
  closePopover();
  const el = h('div.popover', content);
  if (width) el.style.width = width + 'px';
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, hgt = el.offsetHeight;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + hgt > window.innerHeight - 8 && r.top - hgt - 4 > 8) top = r.top - hgt - 4;
    el.style.left = left + 'px'; el.style.top = top + 'px';
  };
  place();
  const onDoc = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closePopover);
  const handle = {
    el, place,
    close() {
      el.remove();
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closePopover);
      onClose && onClose();
    },
  };
  openPop = handle;
  return handle;
}

/** Простое выпадающее меню: items = [{label, onClick, danger, icon} | '-'] */
export function menu(anchor, items, opts) {
  const content = items.map((it) => it === '-' ? h('div.menu-sep')
    : it.head ? h('div.menu-head', it.head)
    : h('div.menu-item' + (it.danger ? '.danger' : ''), { onclick: () => { closePopover(); it.onClick(); } },
        it.icon ? icon(it.icon) : null, it.label));
  return popover(anchor, content, opts);
}

// ---------- Комбобокс (выбор из справочника или добавление нового) ----------
/**
 * combobox({ load: async () => [{id, label}], create: async (text) => ({id,label}) | null,
 *            value: {id,label} | null, placeholder, onChange })
 */
export function combobox({ load, create, value = null, placeholder = 'Выберите…', onChange, autofocus }) {
  let current = value;
  let items = null;
  let hl = 0;
  let pop = null;
  const input = h('input', { type: 'text', placeholder, autocomplete: 'off', value: value ? value.label : '' });
  const clearBtn = h('button.clear', { type: 'button', title: 'Очистить', tabindex: '-1',
    onclick: () => { set(null); input.focus(); } }, icon('close', 14));
  const wrap = h('div.combo', input, clearBtn);
  const sync = () => clearBtn.classList.toggle('hidden', !current);
  sync();

  function set(v, fire = true) {
    current = v;
    input.value = v ? v.label : '';
    sync();
    if (fire && onChange) onChange(v);
  }

  async function open() {
    if (!items) {
      try { items = await load(); } catch (e) { toastError(e); items = []; }
    }
    render();
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    const showAll = current && input.value === current.label;
    const list = (showAll || !q) ? items : items.filter((i) => i.label.toLowerCase().includes(q));
    const exact = items.some((i) => i.label.toLowerCase() === q);
    const opts = list.slice(0, 200).map((it) => ({ it, label: it.label, sub: it.sub }));
    if (create && q && !exact) opts.push({ create: true, label: input.value.trim() });
    hl = Math.min(hl, Math.max(0, opts.length - 1));
    const content = opts.length ? opts.map((o, i) =>
      h('div.menu-item' + (o.create ? '.create' : '') + (i === hl ? '.hl' : ''),
        { onmousedown: (e) => { e.preventDefault(); choose(o); } },
        o.create ? [icon('plus'), `Добавить «${o.label}»`] : [h('span.grow', o.label), o.sub ? h('span.muted.small', o.sub) : null]))
      : h('div.menu-empty', 'Ничего не найдено');
    if (!pop || !pop.el.isConnected) pop = popover(wrap, content, { width: Math.max(wrap.offsetWidth, 220) });
    else { clear(pop.el, content); pop.place(); }
    pop._opts = opts;
    const hlEl = pop.el.querySelector('.hl');
    hlEl && hlEl.scrollIntoView({ block: 'nearest' });
  }
  async function choose(o) {
    if (o.create) {
      const created = await run(() => create(o.label));
      if (!created) return;
      items = null;
      set(created);
    } else set(o.it);
    closePopover(); pop = null;
  }
  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('click', () => { if (!pop || !pop.el.isConnected) open(); });
  input.addEventListener('input', () => { hl = 0; if (items) render(); else open(); });
  input.addEventListener('keydown', (e) => {
    const opts = pop && pop.el.isConnected ? pop._opts : null;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!opts) open(); else { hl = Math.min(hl + 1, opts.length - 1); render(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (opts) { hl = Math.max(hl - 1, 0); render(); } }
    else if (e.key === 'Enter') { if (opts && opts[hl]) { e.preventDefault(); e.stopPropagation(); choose(opts[hl]); } }
    else if (e.key === 'Tab') { closePopover(); }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === input) return;
      // Неподтверждённый текст — вернуть текущее значение
      if (!input.value.trim()) { if (current) set(null); }
      else if (!current || input.value !== current.label) input.value = current ? current.label : '';
      if (pop && pop.el.isConnected) { closePopover(); pop = null; }
    }, 150);
  });
  if (autofocus) setTimeout(() => input.focus(), 30);
  return { el: wrap, input, get: () => current, set: (v) => set(v, false), reset: () => { items = null; } };
}

/** Панель выбора нескольких значений (для фильтров) */
export function multiSelectPopover(anchor, { load, selected = [], onChange, searchable = true }) {
  const sel = new Set(selected.map(String));
  let items = [];
  const search = h('input', { type: 'search', placeholder: 'Поиск…' });
  const listEl = h('div');
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const list = items.filter((i) => !q || i.label.toLowerCase().includes(q));
    clear(listEl, list.length ? list.slice(0, 300).map((it) => {
      const cb = h('input', {
        type: 'checkbox', checked: sel.has(String(it.id)),
        onchange: (e) => {
          if (e.target.checked) sel.add(String(it.id)); else sel.delete(String(it.id));
          onChange([...sel]);
        },
      });
      return h('label.menu-item', cb,
        it.dot ? h('span.type-dot', { style: { background: it.dot } }) : null,
        h('span.grow', it.label));
    }) : h('div.menu-empty', 'Нет значений'));
  };
  search.addEventListener('input', render);
  const pop = popover(anchor, [searchable ? h('div.p-search', search) : null, listEl], { width: 280 });
  (async () => {
    listEl.append(h('div.menu-empty', h('span.spinner')));
    try { items = await load(); } catch (e) { toastError(e); }
    render(); pop.place();
    if (searchable) search.focus();
  })();
  return pop;
}

// ---------- Мелочи ----------
// ---------- Состояния техники (список приходит с сервера, см. store.loadMeta) ----------
let statusList = [];
export const setStatuses = (list) => { statusList = list || []; };
export const statusInfo = (key) =>
  statusList.find((s) => s.key === key) || { key, label: key || '—', color: '#8993A4' };

function hexRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return Number.isNaN(n) ? [137, 147, 164] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (hex, to, k) => {
  const [r, g, b] = hexRgb(hex);
  return `rgb(${[r, g, b].map((c) => Math.round(c + (to - c) * k)).join(',')})`;
};
/** Светлый фон + тёмный текст того же оттенка — как лозенджи в Jira */
const dark = () => document.documentElement.getAttribute('data-theme') === 'dark';
export const softColors = (hex) => (dark()
  ? { background: mix(hex, 29, 0.72), color: mix(hex, 255, 0.45) } // тёмная тема: тёмный фон того же оттенка, светлый текст
  : { background: mix(hex, 255, 0.82), color: mix(hex, 0, 0.45) });
/** Насыщенный фон с читаемым текстом (для кнопки состояния) */
export function solidColors(hex) {
  const [r, g, b] = hexRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { background: hex, color: lum > (dark() ? 0.45 : 0.62) ? (dark() ? '#1D2125' : '#172B4D') : '#FFFFFF' };
}

export function lozenge(status) {
  const s = statusInfo(status);
  return h('span.lozenge', { style: softColors(s.color) }, s.label);
}
export const typeDot = (t) => h('span.type-dot', { style: { background: t.color || t.type_color }, title: t.name || t.type_name },
  (t.code || t.type_code || '').slice(0, 2));
export const deviceKey = (d) => `${d.type_code}-${d.id}`;

const AV_COLORS = ['#0052CC', '#00875A', '#FF5630', '#6554C0', '#00A3BF', '#FF8B00', '#36B37E', '#5243AA'];
export function avatar(name, cls = '') {
  const n = String(name || '?');
  let sum = 0; for (const ch of n) sum += ch.charCodeAt(0);
  const initials = n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  return h('span.avatar' + (cls ? '.' + cls : ''), { style: { background: AV_COLORS[sum % AV_COLORS.length] }, title: n }, initials || '?');
}

export function fmtDate(v, withTime = true) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('ru-RU', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function timeAgo(v) {
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин. назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч. назад`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} дн. назад`;
  return fmtDate(v, false);
}

/** Подсветка найденного текста */
export function highlight(text, q) {
  const s = text == null ? '' : String(text);
  const toks = (q || '').trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!toks.length || !s) return document.createTextNode(s);
  const re = new RegExp(`(${toks.join('|')})`, 'gi');
  const frag = document.createDocumentFragment();
  let last = 0;
  s.replace(re, (m, _g, idx) => {
    frag.append(s.slice(last, idx), h('mark', m));
    last = idx + m.length;
    return m;
  });
  frag.append(s.slice(last));
  return frag;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
