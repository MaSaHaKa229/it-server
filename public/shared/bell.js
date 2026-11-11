// Колокольчик уведомлений в шапке портала (все разделы: портал, инвентарь, заявки, календарь, документы).
// Самостоятельный модуль без зависимостей: календарь и документы (React) подключают его динамически.
// Уведомления: расходники принтеров и МФУ на исходе. Отключить — в настройках уведомлений (здесь же или в профиле).

const STYLE = `
.nb-wrap { position: relative; display: inline-flex; margin-right: 6px; }
.nb-btn { position: relative; width: 34px; height: 34px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: #42526E; display: inline-grid; place-items: center; }
.nb-btn:hover { background: #F4F5F7; color: #172B4D; }
.nb-count { position: absolute; top: 1px; right: 0; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #DE350B; color: #fff; font: 700 10px/16px -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
.nb-count.warn { background: #FF8B00; }
.nb-pop { position: absolute; right: 0; top: 40px; z-index: 500; width: 380px; max-height: 70vh; overflow: auto; background: #fff; border-radius: 3px;
  box-shadow: 0 8px 16px -4px rgba(9,30,66,.25), 0 0 1px rgba(9,30,66,.31); font: 14px/20px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; color: #172B4D; text-align: left; }
.nb-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #EBECF0; font-weight: 600; }
.nb-head small { font-weight: 400; color: #6B778C; }
.nb-item { display: block; padding: 8px 14px; border-left: 3px solid #FF8B00; color: inherit; text-decoration: none; }
.nb-item.critical { border-left-color: #DE350B; }
.nb-item:hover { background: #F4F5F7; text-decoration: none; }
.nb-item b { display: block; }
.nb-item small { color: #6B778C; }
.nb-bar { height: 6px; border-radius: 3px; background: #EBECF0; margin: 4px 0 2px; overflow: hidden; }
.nb-bar > i { display: block; height: 100%; background: #FF8B00; }
.nb-item.critical .nb-bar > i { background: #DE350B; }
.nb-empty { padding: 16px 14px; color: #6B778C; }
.nb-foot { padding: 10px 14px; border-top: 1px solid #EBECF0; background: #FAFBFC; font-size: 13px; }
.nb-foot label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.nb-foot button { margin-top: 8px; border: 0; background: none; color: #0052CC; cursor: pointer; padding: 0; font: inherit; }
.nb-foot button:disabled { color: #6B778C; cursor: default; }
`;

const BELL_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function call(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'portal' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(d?.error || `Ошибка ${r.status}`);
  return d;
}

export const getNotifications = () => call('GET', '/api/notifications');
export const setNotifySetting = (key, value) => call('PUT', '/api/notifications/settings', { [key]: value });

const fmt = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Колокольчик в элемент host (обычно — шапка рядом с именем пользователя) */
export function mountBell(host) {
  if (!document.getElementById('nb-style')) {
    const st = el('style'); st.id = 'nb-style'; st.textContent = STYLE; document.head.append(st);
  }
  const wrap = el('span', 'nb-wrap');
  const btn = el('button', 'nb-btn');
  btn.type = 'button'; btn.title = 'Уведомления'; btn.innerHTML = BELL_SVG;
  const count = el('span', 'nb-count'); count.hidden = true;
  btn.append(count);
  const pop = el('div', 'nb-pop'); pop.hidden = true;
  wrap.append(btn, pop);
  host.append(wrap);
  let data = null;

  const render = () => {
    pop.replaceChildren();
    const head = el('div', 'nb-head', 'Уведомления');
    if (data?.items.length) head.append(el('small', '', `${data.items.length}`));
    pop.append(head);
    if (!data) { pop.append(el('div', 'nb-empty', 'Загрузка…')); return; }
    if (!data.available.printer_supplies) pop.append(el('div', 'nb-empty', 'Уведомлений нет.'));
    else if (!data.prefs.printer_supplies) pop.append(el('div', 'nb-empty', 'Уведомления о расходниках выключены.'));
    else if (!data.items.length) pop.append(el('div', 'nb-empty', `Расходники в порядке: нигде не осталось меньше ${data.threshold}%.`));
    for (const it of data?.prefs.printer_supplies ? data.items : []) {
      const a = el('a', 'nb-item' + (it.level === 'critical' ? ' critical' : ''));
      a.href = `/inventory/#/devices/${it.device_id}`;
      a.append(el('b', '', `${it.supply} — ${it.percent}%`));
      const bar = el('div', 'nb-bar'); const fill = el('i'); fill.style.width = `${Math.max(2, it.percent)}%`; bar.append(fill);
      a.append(bar, el('small', '', [`${it.key} ${it.title}`, it.location, it.department].filter(Boolean).join(' · ')));
      a.title = `Нужна замена: ${it.supply}. Проверено ${fmt(it.checked_at)}`;
      pop.append(a);
    }
    if (data.available.printer_supplies) {
      const foot = el('div', 'nb-foot');
      const lab = el('label');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = data.prefs.printer_supplies;
      cb.addEventListener('change', async () => {
        try { await setNotifySetting('printer_supplies', cb.checked); await load(); } catch (e) { alert(e.message); }
      });
      lab.append(cb, el('span', '', 'Уведомлять о заканчивающихся расходниках принтеров и МФУ'));
      foot.append(lab);
      if (data.canRefresh && data.prefs.printer_supplies) {
        const r = el('button', '', 'Проверить принтеры сейчас');
        r.type = 'button';
        r.addEventListener('click', async () => {
          r.disabled = true; r.textContent = 'Опрашиваю принтеры…';
          try { await call('POST', '/api/notifications/refresh'); await load(); } catch (e) { alert(e.message); }
          r.disabled = false; r.textContent = 'Проверить принтеры сейчас';
        });
        foot.append(el('br'), r);
      }
      pop.append(foot);
    }
  };

  async function load() {
    try { data = await getNotifications(); } catch { return; }
    const n = data.prefs.printer_supplies ? data.items.length : 0;
    count.hidden = !n;
    count.textContent = n > 99 ? '99+' : String(n);
    count.className = 'nb-count' + (data.items.some((x) => x.level === 'critical') ? '' : ' warn');
    btn.title = n ? `Уведомления: ${n}` : 'Уведомления';
    if (!pop.hidden) render();
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) render(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) pop.hidden = true; });
  load();
  const timer = setInterval(load, 5 * 60 * 1000);
  return () => { clearInterval(timer); wrap.remove(); };
}
