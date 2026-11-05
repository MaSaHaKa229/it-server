// Если outdated.js решил, что браузер слишком старый, сборку не запускаем
if (window.__helpdeskOutdated) throw new Error('browser outdated');
// Недостающие в Firefox 52 функции (используются сайтом заявок)
if (!Object.fromEntries) {
  Object.fromEntries = function (entries) {
    var o = {};
    Array.from(entries, function (e) { o[e[0]] = e[1]; });
    return o;
  };
}
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append.apply(this, arguments);
  };
}
// Запасные стили для старых браузеров (gap во flex, inset и т.п.)
(function () {
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/shared/legacy.css';
  document.head.appendChild(l);
  document.documentElement.className += ' legacy';
}());
