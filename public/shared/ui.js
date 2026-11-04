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
export function toast(text, type = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div#toasts.toasts'); document.body.append(box); }
  const el = h('div.toast.' + type, text);
  box.append(el);
  el.addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 3500);
}
/** Выполнить действие, показать ошибку, заблокировать кнопку на время */
export async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message || String(e), 'err'); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ---------- модальные окна ----------
export function modal({ title, body, footer = [], wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', title: 'Закрыть', onclick: close }, '✕')),
    h('div.modal-body', body),
    footer.length ? h('div.modal-foot', footer) : null);
  const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', esc);
  setTimeout(() => box.querySelector('input:not([type=checkbox]):not([disabled]),select,textarea')?.focus(), 30);
  return { close, el: box };
}
export function confirmDialog(title, text, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h('p', text),
      footer: [
        h('button.btn', { onclick: () => m.close() }, 'Отмена'),
        h('button.btn.danger', { onclick: () => { done = true; m.close(); } }, okLabel),
      ],
      onClose: () => resolve(done),
    });
  });
}

// ---------- форматирование ----------
export const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');
export const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');
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
const COLORS = ['#0052CC', '#00A3BF', '#6554C0', '#FF8B00', '#36B37E', '#DE350B', '#5243AA', '#008DA6'];
export function avatar(name, size = '') {
  let hsh = 0; for (const ch of String(name)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return h('span.avatar' + (size ? '.' + size : ''), { style: { background: COLORS[hsh % COLORS.length] }, title: name }, initials(name));
}
export const statusPill = (name, color) => h('span.pill', { style: { background: color + '22', color, borderColor: color + '55' } }, name);

/** Простой роутер по hash: #/path/1?x=y */
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}
