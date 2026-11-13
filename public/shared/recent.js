// Избранное и недавно открытое: кнопка со звёздочкой в шапке всех разделов, звёздочка в карточках
// (техника, рабочее место, заявка, задача, документ). Хранится на сервере у каждого пользователя.
// Самостоятельный модуль без зависимостей (React-клиенты подключают его динамически).

const STYLE = `
.rc-wrap { position: relative; display: inline-flex; margin-right: 2px; }
.rc-btn { width: 34px; height: 34px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: var(--n500,#42526E); display: inline-grid; place-items: center; }
.rc-btn:hover { background: var(--n20,#F4F5F7); color: var(--n800,#172B4D); }
.rc-pop { position: absolute; right: 0; top: 40px; z-index: 505; width: 380px; max-height: 75vh; overflow: auto; background: var(--n0,#fff); border-radius: 3px;
  box-shadow: 0 8px 16px -4px rgba(9,30,66,.25), 0 0 1px rgba(9,30,66,.31); font: 14px/20px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: var(--n800,#172B4D); text-align: left; }
.rc-pop[hidden] { display: none; }
.rc-sec { padding: 10px 14px 4px; font-size: 11px; font-weight: 700; color: var(--n200,#6B778C); text-transform: uppercase; letter-spacing: .03em; }
.rc-item { display: flex; gap: 8px; align-items: center; padding: 6px 14px; color: inherit; text-decoration: none; }
.rc-item:hover { background: var(--n20,#F4F5F7); text-decoration: none; }
.rc-item b { flex: 1; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-item small { color: var(--n200,#6B778C); white-space: nowrap; }
.rc-empty { padding: 8px 14px 12px; color: var(--n200,#6B778C); font-size: 13px; }
.rc-star { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; cursor: pointer; color: var(--n200,#6B778C); font: inherit; font-size: 13px; padding: 4px 6px; border-radius: 3px; }
.rc-star:hover { background: var(--n20,#F4F5F7); color: var(--n800,#172B4D); }
.rc-star.on { color: var(--y500,#FF8B00); }
.rc-star .s { font-size: 18px; line-height: 1; }
`;
const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function style() {
  if (document.getElementById('rc-style')) return;
  const s = el('style'); s.id = 'rc-style'; s.textContent = STYLE; document.head.append(s);
}
async function call(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'portal', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Ошибка ${r.status}`);
  return d;
}

/** Открыли объект — запомнить в «недавних». item: { kind, ref, title, link } */
export const trackView = (item) => call('POST', '/api/my/items/viewed', item).catch(() => ({ favorite: false }));

/** Звёздочка «в избранное» для карточки */
export function starButton(item) {
  style();
  const b = el('button', 'rc-star');
  b.type = 'button';
  const s = el('span', 's');
  const t = el('span');
  b.append(s, t);
  let on = false;
  const draw = () => {
    b.classList.toggle('on', on);
    s.textContent = on ? '★' : '☆';
    t.textContent = on ? 'В избранном' : 'В избранное';
    b.title = on ? 'Убрать из избранного' : 'Добавить в избранное (звёздочка в шапке)';
  };
  draw();
  trackView(item).then((r) => { on = !!r.favorite; draw(); });
  b.addEventListener('click', async () => {
    try { on = !on; draw(); await call('PUT', '/api/my/items/favorite', { ...item, on }); document.dispatchEvent(new CustomEvent('rc-changed')); }
    catch (e) { on = !on; draw(); alert(e.message); }
  });
  return b;
}

/** Кнопка в шапке: избранное и недавно открытое */
export function mountRecent(host) {
  style();
  const wrap = el('span', 'rc-wrap');
  const btn = el('button', 'rc-btn');
  btn.type = 'button'; btn.title = 'Избранное и недавно открытое'; btn.innerHTML = ICON;
  const pop = el('div', 'rc-pop'); pop.hidden = true;
  wrap.append(btn, pop);
  host.append(wrap);

  const item = (x, kinds) => {
    const a = el('a', 'rc-item');
    a.href = x.link;
    a.append(el('span', '', x.favorite ? '★' : '·'), el('b', '', x.title), el('small', '', kinds[x.kind] || ''));
    a.addEventListener('click', () => { pop.hidden = true; });
    return a;
  };
  async function render() {
    pop.replaceChildren(el('div', 'rc-empty', 'Загрузка…'));
    let d;
    try { d = await call('GET', '/api/my/items'); } catch (e) { pop.replaceChildren(el('div', 'rc-empty', e.message)); return; }
    pop.replaceChildren();
    pop.append(el('div', 'rc-sec', 'Избранное'));
    if (d.favorites.length) d.favorites.forEach((x) => pop.append(item(x, d.kinds)));
    else pop.append(el('div', 'rc-empty', 'Пусто. Нажмите «☆ В избранное» в карточке техники, заявки, задачи или документа.'));
    pop.append(el('div', 'rc-sec', 'Недавно открытые'));
    if (d.recent.length) d.recent.forEach((x) => pop.append(item(x, d.kinds)));
    else pop.append(el('div', 'rc-empty', 'Здесь появится то, что вы открывали.'));
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) render(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) pop.hidden = true; });
}
