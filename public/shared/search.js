// Общий поиск по порталу в шапке: техника, заявки, задачи, документы (то, что пользователю разрешено видеть).
// Самостоятельный модуль без зависимостей (подключается из bell.js во всех разделах).

const STYLE = `
.gs-wrap { position: relative; display: inline-block; width: 34px; height: 34px; margin-right: 2px; }
.gs-wrap input.gs-input { position: absolute; right: 0; top: 1px; z-index: 2; width: 34px !important; height: 32px !important; min-width: 0 !important; padding: 0 30px 0 10px !important; border: 2px solid transparent !important;
  border-radius: 16px !important; background: transparent !important; box-shadow: none !important; font: 14px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: #172B4D; outline: none;
  cursor: pointer; transition: width .15s, background .15s; }
.gs-wrap input.gs-input::placeholder { color: transparent; }
.gs-wrap input.gs-input:hover { background: #F4F5F7 !important; }
.gs-wrap.open input.gs-input { width: 340px !important; border-radius: 3px !important; border-color: #4C9AFF !important; background: #fff !important; cursor: text; box-shadow: 0 4px 8px -2px rgba(9,30,66,.25) !important; }
.gs-wrap.open input.gs-input::placeholder { color: #7A869A; }
.gs-ico { position: absolute; right: 10px; top: 10px; z-index: 3; color: #42526E; pointer-events: none; }
.gs-pop { position: absolute; right: 0; top: 38px; z-index: 510; width: 460px; max-height: 75vh; overflow: auto; background: #fff; border-radius: 3px;
  box-shadow: 0 8px 16px -4px rgba(9,30,66,.25), 0 0 1px rgba(9,30,66,.31); font: 14px/20px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: #172B4D; text-align: left; }
.gs-pop[hidden] { display: none; }
.gs-sec { display: flex; justify-content: space-between; padding: 8px 14px 4px; font-size: 11px; font-weight: 700; color: #6B778C; text-transform: uppercase; letter-spacing: .03em; }
.gs-sec a { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 12px; color: #0052CC; text-decoration: none; }
.gs-item { display: block; padding: 6px 14px; color: inherit; text-decoration: none; }
.gs-item:hover, .gs-item.sel { background: #DEEBFF; text-decoration: none; }
.gs-item b { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-item small { display: block; color: #6B778C; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-item.muted b { color: #6B778C; font-weight: 400; }
.gs-empty { padding: 14px; color: #6B778C; }
`;

const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function mountSearch(host) {
  if (!document.getElementById('gs-style')) {
    const st = el('style'); st.id = 'gs-style'; st.textContent = STYLE; document.head.append(st);
  }
  const wrap = el('span', 'gs-wrap');
  const ico = el('span', 'gs-ico'); ico.innerHTML = ICON;
  const input = el('input', 'gs-input');
  input.type = 'search'; input.placeholder = 'Поиск по порталу'; input.autocomplete = 'off';
  input.title = 'Поиск по порталу: техника, заявки, задачи, документы (Ctrl+K)';
  const pop = el('div', 'gs-pop'); pop.hidden = true;
  wrap.append(ico, input, pop);
  host.append(wrap);

  let timer = null;
  let seq = 0;
  let links = [];
  let sel = -1;

  const select = (i) => {
    links.forEach((a) => a.classList.remove('sel'));
    sel = i;
    if (links[i]) { links[i].classList.add('sel'); links[i].scrollIntoView({ block: 'nearest' }); }
  };

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { pop.hidden = true; return; }
    const my = ++seq;
    let d;
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
      d = await r.json();
    } catch { return; }
    if (my !== seq) return;
    pop.replaceChildren(); links = []; sel = -1;
    const secs = (d.sections || []).filter((s) => s.items.length);
    if (!secs.length) pop.append(el('div', 'gs-empty', `Ничего не найдено по запросу «${q}».`));
    for (const s of secs) {
      const h = el('div', 'gs-sec', s.label);
      if (s.more) { const m = el('a', '', 'показать все'); m.href = s.more; h.append(m); }
      pop.append(h);
      for (const x of s.items) {
        const a = el('a', 'gs-item' + (x.muted ? ' muted' : ''));
        a.href = x.link;
        a.append(el('b', '', x.title));
        if (x.text) a.append(el('small', '', x.text));
        a.addEventListener('click', () => { pop.hidden = true; input.blur(); });
        pop.append(a); links.push(a);
      }
    }
    pop.hidden = false;
  }

  const openBox = () => wrap.classList.add('open');
  const closeBox = () => { if (!input.value.trim()) wrap.classList.remove('open'); };
  input.addEventListener('focus', openBox);
  input.addEventListener('blur', () => setTimeout(() => { if (pop.hidden) closeBox(); }, 150));
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && pop.childNodes.length) pop.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(links.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, sel - 1)); }
    else if (e.key === 'Enter') {
      const a = links[sel >= 0 ? sel : 0];
      if (a) { e.preventDefault(); pop.hidden = true; input.blur(); location.href = a.href; }
    } else if (e.key === 'Escape') { pop.hidden = true; input.value = ''; input.blur(); wrap.classList.remove('open'); }
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { pop.hidden = true; closeBox(); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'л' || e.code === 'KeyK')) { e.preventDefault(); input.focus(); input.select(); }
  });
}
