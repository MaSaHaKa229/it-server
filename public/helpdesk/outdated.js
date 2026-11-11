/* Проверка браузера для сайта заявок. Написано на старом JavaScript (ES3), чтобы работать даже в IE8.
   Загружается только браузерами без поддержки модулей (атрибут nomodule). */
(function () {
  var ok = window.fetch && window.Promise && window.Proxy && Array.prototype.includes && Object.entries;
  if (ok) return;
  window.__helpdeskOutdated = true;
  function show() {
    var el = document.getElementById('app') || document.body;
    el.innerHTML =
      '<div style="font:15px/1.5 Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;color:#172B4D">' +
      '<h2 style="font-weight:500">Браузер устарел</h2>' +
      '<p>Сайт заявок не открывается в этом браузере. Откройте его в Firefox (версии 52 и новее), ' +
      'Google Chrome, Microsoft Edge или Яндекс Браузере.</p>' +
      '<p>Если на компьютере нет подходящего браузера — позвоните в ИТ-отдел.</p></div>';
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') show();
  else if (window.addEventListener) window.addEventListener('load', show, false);
  else if (window.attachEvent) window.attachEvent('onload', show);
}());
