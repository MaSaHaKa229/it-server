ПОЛНОЕ ОБНОВЛЕНИЕ ИТ-ПОРТАЛА (все изменения на сегодня)
=====================================================

В архиве полные папки server, public, scripts и файлы проекта.
Папки node_modules нет (зависимости не менялись) — остаётся на сервере.
Файл .env не трогайте.

Папка портала далее — C:\it-portal.

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

4. Проверьте: в C:\it-portal\public должно быть 8 папок:
   calendar, docs, helpdesk, helpdesk-staff, inventory, portal, remote, shared
   В public\remote\downloads — программы удалённого доступа (ITRemoteViewer.exe,
   ITRemoteAgent-x64.exe, ITRemoteAgent-x86.exe).

5. Запустите портал:
   Start-ScheduledTask -TaskName 'IT Portal'
   В C:\it-portal\portal.log должно быть:
     ИТ-портал запущен: http://localhost:3000
     Сайт заявок (helpdesk) запущен: http://localhost:3100
   Если какой-то папки в public не хватает, там будет строка
     ВНИМАНИЕ: папка public неполная. Нет: ...

6. Откройте http://it-portal и войдите.

7. Если всё работает — папки *.bak можно удалить.

НОВОЕ: раздел «Удалённый доступ» (подключение к компьютерам пользователей).
Как начать — INSTALL.md, шаг 10а: выдать права, поставить программу специалиста
и агент на тестовый компьютер (портал → Удалённый доступ → Установка).
Программу специалиста можно поставить удалённо: Удалённый доступ → Настройки →
«Установить RemoteSupport» (нужен пароль администратора компьютера специалиста).

nginx: готовая настройка — scripts\nginx.conf (http://it-portal — портал,
http://helpdesk и обращение по IP — сайт заявок). Порядок установки —
в начале этого файла и в README.md, раздел про nginx.
