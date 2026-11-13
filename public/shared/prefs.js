// Вид портала у каждого пользователя (в этом браузере): тема (светлая / тёмная / как в Windows) и плотность таблиц.
// Обычный скрипт (не модуль) — подключается в <head> до отрисовки, чтобы страница не мигала светлой темой.
(function () {
  var KEY = 'portal.view';
  var root = document.documentElement;
  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* нет места */ } }

  var CSS = [
    /* Тёмная тема — своя палитра в /shared/dark.css (раньше была инверсия цветов — серые буквы на тёмном фоне) */
    'html[data-theme=dark] .pv-box{background:#282E33;color:#DEE4EA}html[data-theme=dark] .pv-box h3,html[data-theme=dark] .pv-box p{color:#9FADBC!important}',
    'html[data-theme=dark] .pv-box button{background:#579DFF;color:#1D2125}',
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

  // Палитра тёмной темы — отдельным файлом; подключается сразу (действует только при data-theme=dark)
  if (!document.getElementById('pv-dark')) {
    if (document.readyState === 'loading') document.write('<link rel="stylesheet" id="pv-dark" href="/shared/dark.css">');
    else { var dl = document.createElement('link'); dl.rel = 'stylesheet'; dl.id = 'pv-dark'; dl.href = '/shared/dark.css'; document.head.appendChild(dl); }
  }

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
    var themeWas = v.theme || 'light';
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
    // Сменили тему — перерисовать страницу: цветные метки (статусы, виды) строятся под тему
    function close() { bg.remove(); if ((read().theme || 'light') !== themeWas) location.reload(); }
    b.addEventListener('click', close);
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(); });
    document.body.appendChild(bg);
  }
  window.portalPrefs = { open: open, apply: apply };

  // ---------- Оформление: логотип, название портала, название предприятия (Администрирование → «Оформление») ----------
  // Применяется ко всем страницам: к значку .brand-logo, подписи рядом с ним, заголовку окна и [data-brand-company].
  // Последние настройки запоминаются в браузере — страница сразу открывается со своим логотипом, без мигания.
  var BKEY = 'portal.brand';
  var brand = null;
  try { brand = JSON.parse(localStorage.getItem(BKEY)); } catch (e) { brand = null; }
  var DEF_TITLE = 'ИТ-портал';
  function applyBrand() {
    if (!brand || !document.body) return;
    var logos = document.querySelectorAll('.brand-logo:not(.hd)');
    for (var i = 0; i < logos.length; i++) {
      var el = logos[i];
      if (brand.logo) {
        if (el.getAttribute('data-brand') !== brand.logo.length + '') {
          el.style.backgroundImage = 'url("' + brand.logo + '")';
          el.style.backgroundSize = 'contain'; el.style.backgroundRepeat = 'no-repeat'; el.style.backgroundPosition = 'center';
          el.style.backgroundColor = 'transparent'; el.style.color = 'transparent';
          el.setAttribute('data-brand', brand.logo.length + '');
        }
      } else if (el.getAttribute('data-brand')) {
        el.style.backgroundImage = ''; el.style.backgroundColor = ''; el.style.color = ''; el.removeAttribute('data-brand');
      }
      // Подпись рядом со значком: «Портал» в шапке, «ИТ-портал» на странице входа
      var next = el.nextSibling;
      var want = el.parentNode && el.parentNode.className.indexOf('login-brand') >= 0 ? brand.portal_title : brand.portal_short;
      if (next && want) {
        if (next.nodeType === 3) { if (next.nodeValue.trim() !== want) next.nodeValue = ' ' + want; }
        else if (next.nodeType === 1 && next.tagName === 'SPAN' && !next.className && next.textContent !== want) next.textContent = want;
      }
    }
    // «ИТ-портал» в строке пути (хлебных крошках)
    if (brand.portal_title && brand.portal_title !== DEF_TITLE) {
      var crumbs = document.querySelectorAll('.breadcrumbs a[href="/"], .breadcrumbs > span:first-child');
      for (var k = 0; k < crumbs.length; k++) if (crumbs[k].textContent === DEF_TITLE) crumbs[k].textContent = brand.portal_title;
    }
    var comp = document.querySelectorAll('[data-brand-company]');
    for (var j = 0; j < comp.length; j++) {
      var txt = brand.company ? (comp[j].getAttribute('data-sep') || '') + brand.company : '';
      if (comp[j].textContent !== txt) comp[j].textContent = txt;
      comp[j].style.display = brand.company ? '' : 'none';
    }
    if (brand.portal_title && brand.portal_title !== DEF_TITLE && document.title.indexOf(DEF_TITLE) >= 0) {
      document.title = document.title.split(DEF_TITLE).join(brand.portal_title);
    }
  }
  var pending = false;
  function later() { if (pending) return; pending = true; setTimeout(function () { pending = false; applyBrand(); }, 30); }
  function watch() {
    applyBrand();
    if (window.MutationObserver) new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  if (window.fetch) {
    fetch('/api/branding', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      if (!b) return;
      brand = b;
      try { localStorage.setItem(BKEY, JSON.stringify(b)); } catch (e) { /* нет места */ }
      applyBrand();
    }).catch(function () { /* без оформления */ });
  }
  window.portalPrefs.brand = function (b) { brand = b; try { localStorage.setItem(BKEY, JSON.stringify(b)); } catch (e) { /* нет места */ } applyBrand(); };
})();
