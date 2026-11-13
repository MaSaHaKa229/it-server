ПОЛНОЕ ОБНОВЛЕНИЕ ИТ-ПОРТАЛА (все изменения на сегодня)
=====================================================

В архиве полные папки server, public, scripts и файлы проекта.
Папки node_modules в этом архиве нет и переносить её не нужно.
Компоненты распознавания сканов PDF лежат внутри папки server
(server\vendor\ocr) и устанавливаются вместе с ней.
Файл .env не трогайте.

Папка портала далее — C:\it-portal.

ПРОСТОЙ СПОСОБ (рекомендуется)
------------------------------
1. Распакуйте архив в любое место, кроме C:\it-portal (например, на Рабочий стол).
2. В распакованной папке it-portal дважды щёлкните «ОБНОВИТЬ ПОРТАЛ.cmd»
   и разрешите запуск от имени администратора.
3. Дождитесь надписи «Готово». Сценарий сам:
   - сделает резервную копию базы;
   - остановит портал;
   - сохранит прежнюю версию в C:\it-portal\_before-update\<дата>;
   - скопирует новые файлы (.env, node_modules и резервные копии не трогаются);
   - запустит портал и проверит, что он открывается.
   Если портал не запустится, сценарий предложит вернуть прежнюю версию.
   Ход обновления записывается в C:\it-portal\update.log.
4. Откройте http://it-portal → Администрирование → «Состояние системы».

Если портал установлен не в C:\it-portal — запустите из PowerShell:
   powershell -ExecutionPolicy Bypass -File scripts\update-portal.ps1 -Target D:\путь\к\порталу

ВРУЧНУЮ (если простой способ не сработал)
----------------------------------------
1. Остановите портал (PowerShell от имени администратора):
   Stop-ScheduledTask -TaskName 'IT Portal'
   (если портал запущен окном start-portal.bat — закройте окно)

2. Уберите старые папки (переименуйте, чтобы можно было вернуть):
   C:\it-portal\server   ->  server.bak
   C:\it-portal\public   ->  public.bak
   C:\it-portal\scripts  ->  scripts.bak
   Если остались server.old, public.old, public\calendar.old от прошлых
   обновлений — их можно удалить.

3. Скопируйте из архива в C:\it-portal ВСЁ содержимое папки it-portal:
   папки server, public, scripts и файлы package.json, package-lock.json,
   start-portal.bat, README.md, INSTALL.md, .env.example.

4. Проверьте: в C:\it-portal\public должно быть 7 папок:
   calendar, docs, helpdesk, helpdesk-staff, inventory, portal, shared

5. Запустите портал:
   Start-ScheduledTask -TaskName 'IT Portal'
   В C:\it-portal\portal.log должно быть:
     ИТ-портал запущен: http://localhost:3000
     Сайт заявок (helpdesk) запущен: http://localhost:3100
   Если какой-то папки в public не хватает, там будет строка
     ВНИМАНИЕ: папка public неполная. Нет: ...
   Строки «Распознавание сканов PDF недоступно» быть не должно.

6. Откройте http://it-portal и войдите.

7. Если всё работает — папки *.bak можно удалить.

nginx: готовая настройка — scripts\nginx.conf (http://it-portal — портал,
http://helpdesk и обращение по IP — сайт заявок). Порядок установки —
в начале этого файла и в README.md, раздел про nginx.
