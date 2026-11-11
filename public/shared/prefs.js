// Вид портала у каждого пользователя (в этом браузере): тема (светлая / тёмная / как в Windows) и плотность таблиц.
// Обычный скрипт (не модуль) — подключается в <head> до отрисовки, чтобы страница не мигала светлой темой.
(function () {
  var KEY = 'portal.view';
  var root = document.documentElement;
  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* нет места */ } }

  var CSS = [
    /* Тёмная тема: инверсия яркости с сохранением оттенков; картинки и цветные метки возвращаются как были */
    'html[data-theme=dark]{filter:invert(.9) hue-rotate(180deg);background:#fff}',
    'html[data-theme=dark] img,html[data-theme=dark] video,html[data-theme=dark] canvas,html[data-theme=dark] iframe,',
    'html[data-theme=dark] .avatar,html[data-theme=dark] .brand-logo{filter:invert(1) hue-rotate(180deg)}',
    /* Компактные таблицы и списки */
    'html[data-density=compact] table.list td,html[data-density=compact] table.list th{padding-top:3px!important;padding-bottom:3px!important}',
    'html[data-density=compact] table.list td{height:auto!important}',
    'html[data-density=compact] .agenda-row{padding-top:3px!important;padding-bottom:3px!important;min-height:0!important}',
    'html[data-density=compact] .result,html[data-density=compact] .doc-row{padding-top:6px!important;padding-bottom:6px!important}',
    'html[data-density=compact] .side-link{padding-top:3px!important;padding-bottom:3px!important;min-height:0!important;height:auto!important}',
    'html[data-density=compact] .nb-item,html[data-density=compact] .home-row{padding-top:4px!important;padding-bottom:4px!important}',
    /* Окно настроек вида */
    '.pv-bg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(9,30,66,.54);z-index:3000;display:flex;align-items:flex-start;justify-content:center;padding-top:80px}',
    '.pv-box{background:#fff;border-radius:3px;width:420px;padding:20px 24px;font:14px/20px -apple-system,"Segoe UI",Roboto,sans-serif;color:#172B4D;box-shadow:0 8px 16px -4px rgba(9,30,66,.25)}',
    '.pv-box h2{margin:0 0 12px;font-size:20px;font-weight:500}.pv-box h3{margin:14px 0 6px;font-size:13px;color:#5E6C84;text-transform:uppercase;letter-spacing:.03em}',
    '.pv-box label{display:block;margin:4px 0;cursor:pointer}.pv-box input{margin-right:8px}',
    '.pv-box .pv-ok{display:flex;justify-content:flex-end;margin-top:16px}.pv-box button{background:#0052CC;color:#fff;border:0;border-radius:3px;padding:6px 14px;font:inherit;cursor:pointer}',
  ].join('\n');

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var v = read();
    var dark = v.theme === 'dark' || (v.theme === 'auto' && media && media.matches);
    if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    if (v.density === 'compact') root.setAttribute('data-density', 'compact'); else root.removeAttribute('data-density');
  }
  function style() {
    if (document.getElementById('pv-style')) return;
    var s = document.createElement('style'); s.id = 'pv-style'; s.textContent = CSS;
    (document.head || root).appendChild(s);
  }
  style();
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);

  function radio(name, value, label, cur) {
    var l = document.createElement('label');
    var i = document.createElement('input'); i.type = 'radio'; i.name = name; i.value = value; i.checked = cur === value;
    i.addEventListener('change', function () { var v = read(); v[name] = value; save(v); apply(); });
    l.appendChild(i); l.appendChild(document.createTextNode(label));
    return l;
  }
  function open() {
    var v = read();
    var bg = document.createElement('div'); bg.className = 'pv-bg';
    var box = document.createElement('div'); box.className = 'pv-box';
    var h = document.createElement('h2'); h.textContent = 'Вид портала';
    box.appendChild(h);
    var t = document.createElement('h3'); t.textContent = 'Тема'; box.appendChild(t);
    box.appendChild(radio('theme', 'light', 'Светлая', v.theme || 'light'));
    box.appendChild(radio('theme', 'dark', 'Тёмная', v.theme || 'light'));
    box.appendChild(radio('theme', 'auto', 'Как в Windows', v.theme || 'light'));
    var d = document.createElement('h3'); d.textContent = 'Таблицы и списки'; box.appendChild(d);
    box.appendChild(radio('density', 'normal', 'Обычно', v.density || 'normal'));
    box.appendChild(radio('density', 'compact', 'Компактно — больше строк на экране', v.density || 'normal'));
    var p = document.createElement('p'); p.style.cssText = 'color:#6B778C;font-size:12px;margin:12px 0 0';
    p.textContent = 'Запоминается в этом браузере и действует во всех разделах портала.';
    box.appendChild(p);
    var ok = document.createElement('div'); ok.className = 'pv-ok';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Готово';
    ok.appendChild(b); box.appendChild(ok);
    bg.appendChild(box);
    function close() { bg.remove(); }
    b.addEventListener('click', close);
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(); });
    document.body.appendChild(bg);
  }
  window.portalPrefs = { open: open, apply: apply };
})();
