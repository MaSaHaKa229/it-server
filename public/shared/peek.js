// Предпросмотр по наведению: навели на ссылку на технику, заявку, задачу или документ — через полсекунды
// всплывает короткая карточка. Работает во всех разделах (подключается из bell.js).

const STYLE = `
.pk-card { position: fixed; z-index: 2000; width: 340px; background: var(--pk-bg, #fff); color: var(--pk-text, #172B4D); border-radius: 3px; padding: 12px 14px;
  box-shadow: 0 8px 16px -4px rgba(9,30,66,.25), 0 0 1px rgba(9,30,66,.31); font: 13px/18px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  pointer-events: none; animation: pk-in .12s; }
@keyframes pk-in { from { opacity: 0; transform: translateY(4px); } }
.pk-kind { font-size: 11px; font-weight: 700; color: var(--n200,#6B778C); text-transform: uppercase; letter-spacing: .03em; display: flex; align-items: center; gap: 6px; }
.pk-kind i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.pk-title { font-size: 14px; font-weight: 600; margin: 4px 0 6px; }
.pk-badge { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
.pk-rows { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
.pk-rows span { color: var(--n200,#6B778C); }
.pk-text { margin-top: 6px; color: var(--n300,#5E6C84); max-height: 54px; overflow: hidden; }
`;

// Какие ссылки показывают карточку: [вид, проверка адреса → id]
const RULES = [
  ['ticket', (u) => (u.pathname.startsWith('/helpdesk') && (u.hash.match(/^#\/tickets\/(\d+)$/) || [])[1])],
  ['device', (u) => (u.pathname.startsWith('/inventory') && (u.hash.match(/^#\/devices\/(\d+)$/) || [])[1])],
  ['task', (u) => (u.pathname.startsWith('/calendar') && (u.hash.match(/[?&]task=(\d+)/) || [])[1])],
  ['document', (u) => (u.pathname.match(/^\/docs\/documents\/(\d+)$/) || [])[1]],
];

const cache = new Map();
let card = null;
let timer = null;
let current = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function target(a) {
  if (!a) return null;
  // Явная отметка: data-peek="ticket:12"
  if (a.dataset && a.dataset.peek) { const [kind, id] = a.dataset.peek.split(':'); return { kind, id }; }
  if (!a.href || a.closest('.pk-card, nav, .topnav, .sidebar, .menu-item, .side-link, .breadcrumbs, .gs-pop, .rc-pop, .nb-pop, .home-card')) return null;
  let u;
  try { u = new URL(a.href, location.href); } catch { return null; }
  if (u.origin !== location.origin) return null;
  for (const [kind, test] of RULES) {
    const id = test(u);
    if (id) return { kind, id };
  }
  return null;
}

async function load(t) {
  const key = `${t.kind}:${t.id}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`/api/peek?kind=${t.kind}&id=${t.id}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
    setTimeout(() => cache.delete(key), 60 * 1000);
  }
  return cache.get(key);
}

function show(a, d) {
  hide();
  if (!d) return;
  card = el('div', 'pk-card');
  const kind = el('div', 'pk-kind');
  if (d.color) { const i = el('i'); i.style.background = d.color; kind.append(i); }
  kind.append(d.kind);
  card.append(kind, el('div', 'pk-title', d.title));
  if (d.badge && d.badge.text) {
    const b = el('span', 'pk-badge', d.badge.text);
    b.style.background = (d.badge.color || '#6B778C') + '26'; b.style.color = d.badge.color || 'var(--n500,#42526E)';
    card.append(b);
  }
  if (d.rows && d.rows.length) {
    const g = el('div', 'pk-rows');
    d.rows.forEach(([k, v]) => g.append(el('span', '', k), el('div', '', v)));
    card.append(g);
  }
  if (d.text) card.append(el('div', 'pk-text', d.text));
  document.body.append(card);
  const r = a.getBoundingClientRect();
  const w = card.offsetWidth;
  const hgt = card.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 12);
  let top = r.bottom + 8;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 8);
  card.style.left = Math.max(8, left) + 'px';
  card.style.top = top + 'px';
}
function hide() { if (card) { card.remove(); card = null; } }

export function initPeek() {
  if (window.__peekInit) return;
  window.__peekInit = true;
  const st = el('style'); st.textContent = STYLE; document.head.append(st);
  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest('[data-peek], a[href]');
    if (a === current) return;
    current = a;
    clearTimeout(timer);
    hide();
    const t = target(a);
    if (!t) return;
    timer = setTimeout(async () => {
      const d = await load(t);
      if (current === a && document.body.contains(a)) show(a, d);
    }, 450);
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); hide(); });
  window.addEventListener('scroll', hide, true);
}
