# ИТ-портал — контекст проекта

Единый сайт службы ИТ предприятия: ИТ-инвентарь, документы, задачи с календарём, заявки (helpdesk).
Node.js (Express) + PostgreSQL. Описание возможностей — `README.md`, установка и обновление — `INSTALL.md`.
С пользователем общаемся **по-русски**; интерфейс, комментарии в коде, коммиты и PR — тоже на русском.

## Где это работает

- Сервер заказчика: **виртуальная машина Windows 11 без интернета**, папка `C:\it-portal`, PostgreSQL на той же машине
  (база `itdb`, в ней изначально был только ИТ-инвентарь с живыми данными — их нельзя терять).
- Запуск — задание Планировщика «IT Portal» (`scripts/install-autostart.ps1`), журнал `C:\it-portal\portal.log`.
- Перед порталом nginx (`scripts/nginx.conf`): `http://it-portal` → порт 3000, `http://helpdesk` и обращение по IP → порт 3100.
- Часть компьютеров сотрудников — Windows XP с **Firefox 52 ESR**: сайт заявок обязан в нём открываться.
- Порталом пользуются **только с ПК**. Версию под телефон (адаптивную вёрстку, `@media` для узких экранов)
  для новых функций не делать и на ширине телефона не проверять — так просил пользователь.
  Уже существующие адаптивные стили не трогать.
- Всё должно работать офлайн: никаких CDN, внешних шрифтов и скриптов. Зависимости — только чистый JavaScript
  (без компилируемых модулей), чтобы `node_modules` переносилась между Linux и Windows.

## Архитектура

Один процесс Node.js (`server/index.js`), два порта:

| Порт | Что | Код |
|---|---|---|
| `PORT` (3000) | портал службы ИТ: `/`, `/admin`, `/inventory/`, `/docs/`, `/calendar/`, `/helpdesk/` | `server/portal`, `server/inventory`, `server/docs`, `server/calendar` (ES-модули), `server/helpdesk/staff.js` |
| `HELPDESK_PORT` (3100) | сайт заявок для всех сотрудников | `server/helpdesk/public.js` |

Одна база, схемы: `public` — инвентарь и пользователи портала, `docs`, `calendar`, `helpdesk`
(`server/db.js`: `poolFor(schema)` ставит `search_path`). Миграции — идемпотентные `schema.sql` в каждом модуле,
выполняются **при каждом запуске** (`server/setup.js`). Новые изменения схемы — только через
`CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` в конце соответствующего `schema.sql`.

**Пользователи и права.** Источник истины — `public.users` (таблица инвентаря): `role` (`superadmin` — администратор
портала; `editor`/`reader` — уровень в инвентаре), `permissions` (тонкие права читателя инвентаря), `modules` (JSONB):
`inventory`, `docs`, `calendar`, `helpdesk` — уровни из `server/portal/modules.js`; плюс `docs_types`, `docs_folders`,
`calendar_own_only`, для уровня «Просмотр» календаря — `calendar_cats`/`calendar_people` (null — все, 0 — «без категории»/
«без исполнителя») и `calendar_absences` ('all'/'none'/[id]); применяются в `server/calendar/scope.js` (`taskCond`,
`absenceCond`) во всех запросах задач, серий, отсутствий и счётчиков, включая главную. Сессия общая (cookie `itdb.sid`, express-session в PostgreSQL). `server/portal/sync.js` копирует
пользователей в `docs.users` и `calendar.users` с теми же id (нужны для связей «автор», «исполнитель»).
Заявители helpdesk — отдельная таблица `helpdesk.requesters` и своя сессия (`helpdesk.sid`).
**Служебная учётная запись** (просьба пользователя) — `public.users.is_service` (флажок в окне пользователя, только у
администратора портала; при первом обновлении ставится на `admin`). Скрывается **только она**, остальные администраторы
портала (`role = 'superadmin'`) — обычные сотрудники: есть в исполнителях, календаре и т. д. (однажды по ошибке скрыли всех
суперадминистраторов — пользователь жаловался). Служебная запись кроме панелей администрирования нигде не
показывается — нет в списках людей (исполнители, фильтры, статистика, отпуска, исполнители helpdesk), а в авторах,
журналах и переписке вместо его имени — «Служба ИТ». В `calendar.users`/`docs.users` — флаг `is_system` (= `is_service`, ставят sync и
миграция), в `public.users` — проверка `is_service`. Новые запросы с именами людей делать так же.

Все права проверяются на сервере. Изменяющие запросы к API требуют заголовок `X-Requested-With` (защита от CSRF).

**Связи между модулями:**
- заявка helpdesk ↔ задача календаря (`server/helpdesk/calendar-sync.js`: из заявки — всё, из задачи — только статус);
- заявка → техника инвентаря: `helpdesk.ticket_devices` (несколько устройств; `tickets.device_id` — первое, для совместимости);
  привязка/отвязка — исполнитель или админ helpdesk, пишется в `history` заявки и `public.device_history` (ticket_linked/unlinked);
- срок заявки выставляет администратор helpdesk (или он ставится по нормативу вида проблемы и подтверждается администратором);

**Регулярные задачи календаря** — `calendar.task_series` (шаблон, `every_months` — помесячные, либо `every_days` 1/7/14 + `weekdays` (isodow) — ежедневные/по будням/еженедельные/через неделю; `until`, `tz`; ключ частоты для клиента — `FREQ_SQL`); повторы — обычные
строки `tasks` с `series_id`/`series_idx`, создаются по требованию `ensureOccurrences()` (`server/calendar/series.js`)
при запросе периода и таймером (помесячные — на год вперёд, по дням — на 62 дня); удалённые по одному — в `task_series_skips`. Даты повторов считаются
в часовом поясе серии (`tz` из браузера), иначе «1-е число» уезжает при поясе базы ≠ поясу пользователей.
Отсутствия сотрудников — `calendar.absences`. Дата выполнения задачи `completed_at` ставится триггером.

**Сведения из сети в инвентаре** (`server/inventory/netprobe/`, по мотивам программы NetMon пользователя): ping, порты,
NetBIOS, ARP, SNMP — на чистом Node.js (`probes.js`); AD и WMI — встроенный PowerShell Windows (`powershell.js`),
имя/логин/пароль передаются через переменные окружения `NM_*`, не в тексте команды. Опрос — фоновое задание в памяти,
браузер опрашивает статус; результат — `device_netinfo`, настройки (одна строка, пароль зашифрован) — `netprobe_settings`.
Кнопка — только редакторам, настройки — только суперадмину.
**Сканирование сети** — `server/inventory/netprobe/scan.js` (+ `public/inventory/js/pages/netscan.js`): поиск (порты → ping → ARP),
опознание, по желанию WMI; результат — `netscan_last` (одна строка), скрытые — `netscan_ignore`; совпадения с базой
считаются при каждом GET (MAC/серийный → имя → IP); «Дополнить» использует `renderCompare`/`applyToDevice` из netinfo.js.
«Ждут решения» — `netscan_hosts` (state pending/done, handled_sig — подпись отличий на момент решения).
**Уведомления** — `server/portal/notify.js`: список видов `KINDS` (кому доступен, событие или вычисляемое состояние),
`emit(userIds, kind, {title, body, link}, except)` для событий (таблица `public.notifications` + письмо), вычисляемые
(сроки заявок/задач, расходники `netprobe/supplies.js`, гарантия — доп. поля-даты со словами «гарантия/лиценз/срок…»,
«не в сети» — `device_seen`, инвентаризация) считаются при запросе; на почту — раз в 15 мин, отправленные — `notify_sent`.
Настройки пользователя — `users.notify_prefs` `{kind: {site, email}}`; пороги — `portal_settings.notify`.
Почта — `server/portal/mail.js` (настройки в `portal_settings.smtp`, пароль зашифрован; иначе SMTP_* из .env), её же
использует helpdesk. Клиент — `public/shared/bell.js` (колокольчик, окно настроек, `mountHeaderTools` = поиск + колокольчик;
React-клиенты грузят его динамически по адресу-переменной, иначе Vite не соберёт), общий поиск — `public/shared/search.js`
+ `server/portal/search.js` (права: инвентарь `perms`, календарь `scope.js`, документы `access.js`).
**Администрирование** (`/admin#users|notify|backup|audit`, `public/portal/admin-extra.js`): резервные копии —
`server/portal/backup.js` (свой формат `*.itbak`: gzip JSON-строк `to_jsonb` всех таблиц 4 схем без сессий; восстановление
в одной транзакции: FK → DEFERRABLE, `DISABLE TRIGGER USER`, TRUNCATE, `jsonb_populate_recordset`, setval; перед ним —
копия текущего состояния; расписание и папка — `portal_settings.backup`); журнал — `server/portal/audit.js`
(`log(req, action, object, details)`, `trackChanges([[путь, действие]])` для админских маршрутов), таблица `audit_log`.
**Helpdesk**: отчёты `server/helpdesk/reports.js` (+ Excel), автоназначение `server/helpdesk/autoassign.js` (`assign_rules`,
пропускает отсутствующих по `calendar.absences`), страницы — `public/helpdesk-staff/extra.js`.
**Инвентаризация** — `server/inventory/routes/audits.js`, `public/inventory/js/pages/audits.js` (`inventory_audits`,
`inventory_audit_items` со снимком устройства; завершение пишет `device_history` action `audit`).
**Подключение к сеансу** (RDP shadow) — `netprobe/remote.js`: кнопка в карточке скачивает `.cmd` с
`powershell -EncodedCommand` (qwinsta → `mstsc /shadow`, иначе msra/RDP), настройка `netprobe_settings.remote_connect`
(enabled/control/consent, меняет суперадмин), каждое скачивание — `device_history` action `remote_connect`. На Windows не проверялось.
**Перемещения** — `device_moves` (`server/inventory/routes/moves.js`, `public/inventory/js/pages/moves.js`: окно
«Переместить», «Изменить поля…» → `devices/bulk` action `update` через `updateDevice()` из devices.js).
**Заявки сотрудника в рабочем месте** — `workplaces.requester_id` (колонка добавляется в helpdesk/schema.sql, т. к. FK на
`helpdesk.requesters`), маршруты `workplaces/:id/tickets|requester`, `workplaces/requesters/search` (только с доступом к helpdesk).
**Заявка за сотрудника** — `POST /helpdesk/api/tickets` (staff.js, `requesterFor`: e-mail обязателен (просьба пользователя — без дублей заявителей), такой заявитель
создаётся с `email_verified=false`, и регистрация на сайте заявок с тем же адресом «забирает» эту запись), `tickets.channel`; **норматив** — `categories.sla_hours`,
`tickets.due_auto` (подтверждение `confirm_due`), это смягчает правило «срок ставит только администратор».
**Задача → заявка** — `calendar-sync.fromTask()` из PATCH задачи (только статус).
**Сохранённые фильтры, избранное, недавние** — `server/portal/views.js` (`/api/my/views`, `/api/my/items`; таблицы
`saved_views`, `user_items`), клиент — `public/shared/recent.js` (`starButton`, `mountRecent` в `mountHeaderTools`).
**Excel** — `server/portal/xlsx.js` `sendXlsx()`; маршруты `…/export.xlsx` используют те же отборы, что списки.
**UI-общее:** `/shared/prefs.js` — обычный скрипт в `<head>` всех страниц портала (тема `data-theme=dark` — инверсия
через `filter`, плотность `data-density=compact`, окно `window.portalPrefs.open()`; в календаре больше не ставить
`data-theme` в main.jsx); `/shared/peek.js` — карточка по наведению (`/api/peek`, ссылки или `data-peek="kind:id"`);
меню «Ещё ▾» — 4-й элемент `true` в nav (`topbar` в ui.js, инвентарь, календарь); `toast(text, type, title, { undo })`;
справка — `public/portal/help.js` (`/help`, разделы и пункты по правам пользователя — условия в `SECTIONS`); «Все настройки» — `admin-extra.js` `SETTINGS_MAP` (новые настройки добавлять туда).
**Состояние системы** — `/admin#status`, `server/portal/status.js` (версия из `server/version.json`, который пишет
`make-update.sh`; диск, база, самопроверка) + `server/portal/health.js` (`register`/`track` фоновых заданий, `captureErrors()`
— кольцевой буфер `console.error`). Новые фоновые таймеры оборачивать в `track`.
**Сканирование по расписанию** — `netprobe_settings.scan_schedule`, `scan.js` `startSchedule()`; новые — уведомление `netscan_new`.
Главная — `public/portal/home.js` + `/api/summary/my` (мои заявки, мои задачи на сегодня, уведомления).
Значения для карточки — `netprobe/format.js`: шаблоны (`netprobe_settings.formats`) и замены (`netprobe_replacements`). Поиск в AD: база из настроек → домен контроллера → GC:// леса
(ReferralChasing=All; у пользователя была ошибка «A referral was returned from the server»). Без Windows AD/WMI не работают: для проверки
`NETPROBE_FAKE_DIR=<папка>` подставляет ответы из `<ad|wmi>[-ИМЯ].json`. На реальной Windows/AD не проверялось.

## Интерфейсы

| Раздел | Технология | Исходники | Что отдаётся |
|---|---|---|---|
| Портал (главная, вход, админка), заявки службы ИТ, сайт заявок, инвентарь | чистый JS, ES-модули, без сборки | `public/portal`, `public/helpdesk-staff`, `public/helpdesk`, `public/inventory`, `public/shared` | те же файлы |
| Документы | React + Vite | `clients/docs` | `public/docs` (сборка, **в репозитории**) |
| Календарь | React + Vite | `clients/calendar` | `public/calendar` (сборка, **в репозитории**) |
| Сайт заявок для Firefox 52 | esbuild | `clients/helpdesk-legacy` | `public/helpdesk/app.legacy.js`, `public/shared/legacy.css` (**в репозитории**) |

Единый дизайн — как в ИТ-инвентаре (стиль Jira): `public/shared/theme.css` (общая тема, её же грузит инвентарь)
и `public/shared/portal.css`; React-клиенты повторяют те же токены в своих `styles.css`.
Общие компоненты ванильных страниц — `public/shared/ui.js` (`h()`, `makeApi`, `modal`, `toast`, `topbar`, сортировка таблиц).

**После правок обязательно пересобрать и закоммитить сборку:**
- `clients/docs` или `clients/calendar` → `npm run build` в этой папке;
- `public/helpdesk/app.js`, `public/shared/ui.js`, `thread.js`, `theme.css`, `portal.css` →
  `npm --prefix clients/helpdesk-legacy run build` (иначе Firefox 52 не увидит изменений).

Сервер без интернета ничего не собирает — он получает готовые файлы из `public`.

## Запуск и проверка в облачной сессии

```bash
service postgresql start
su postgres -c "psql -c \"CREATE USER itdb WITH PASSWORD 'itdb_password'\" -c \"CREATE DATABASE itdb OWNER itdb\""
npm install                                   # корневые зависимости
cp .env.example .env                          # заполнить SESSION_SECRET и APP_SECRET_KEY любыми строками; NODE_ENV=development
node server/setup.js --demo                   # схема + admin/admin12345 + демо-техника
node server/index.js                          # http://localhost:3000 и http://localhost:3100
npm run build:install && npm run build        # только если правились React-клиенты или сайт заявок
```

Контейнер сессии одноразовый: база и `.env` не сохраняются между сессиями — создавайте заново.
Пользователь базы намеренно **не суперпользователь** (как на сервере заказчика): миграции должны проходить от владельца базы.

Как проверять изменения (так делалось всё время):
1. API — `curl` с cookie-файлом и `-H X-Requested-With:portal` (для порта 3100 — `helpdesk`);
2. страницы — Playwright (Chromium предустановлен): пройти сценарий, собрать `pageerror`/`console.error`, посмотреть скриншоты;
3. миграции — запуск на чистой базе, повторный запуск и запуск поверх базы предыдущей версии;
4. права — тем же сценарием под ограниченным пользователем (чужое должно давать 403/404);
5. Firefox 52 — эмуляция: страница без `<script type="module">` и с удалёнными новыми функциями
   (`Object.fromEntries`, `replaceChildren`, …). Настоящий Firefox 52 и Windows в сессии недоступны —
   это каждый раз явно сообщается пользователю как непроверенное.

## Как выпускаются изменения

1. Ветка от `main`, коммиты и PR на русском; в PR — что сделано и как проверено, что не проверено.
2. Пользователь не разработчик и ставит обновления вручную, поэтому после каждого изменения ему отправляется
   **полный архив обновления**: `scripts/make-update.sh` → `it-portal-full-update.zip`
   (папки `server`, `public`, `scripts`, файлы проекта и `УСТАНОВКА.txt` из `scripts/UPDATE-README.txt`).
   Частичные архивы не присылать: однажды из-за этого на сервере пропала часть папки `public`.
3. `node_modules` в архив не входит. Если меняется корневой `package.json` — предупредить отдельно:
   зависимости придётся переносить с компьютера с интернетом (`INSTALL.md`, шаг 1).
4. В ответе пользователю — коротко и без жаргона: что изменилось, как проверено, как установить.

## Грабли, на которые уже наступали

- **Кэш браузера.** Скрипты с постоянными адресами отдаются с `Cache-Control: no-cache` (`cacheHeaders` в
  `server/index.js`); долго кэшируются только файлы сборок с хэшем в имени. Не возвращать `maxAge`.
- **Неполная папка `public`** после ручного обновления — портал проверяет её при запуске (`checkPublic`).
  Сообщение «Не найден файл …» в `sendPage` — только если файла действительно нет (раньше писалось и при прерванной
  браузером загрузке — пользователь пугался).
- **Шум распознавания** («Image too small to scale!!», «Line cannot be recognized!!») — `debug_file=/dev/null` и фильтр
  вывода `quietTesseractOutput()` в `server/docs/ocr.js`; не ошибки.
- **nginx на Windows:** каждый `start nginx` запускает ещё один процесс; перед запуском `taskkill /f /im nginx.exe`.
- **`.bat`/`.ps1`/`UPDATE-README.txt`** — CRLF, для `.ps1` и текстового файла ещё и BOM (кириллица в Windows).
- **`APP_SECRET_KEY`** из старого `.env` инвентаря менять нельзя — им зашифрованы пароли устройств.
- В Firefox 52 нет `gap` во flex-блоках, `inset`, `dateStyle` — запасные стили генерируются сборкой
  `clients/helpdesk-legacy`; в коде сайта заявок новые функции браузера использовать осторожно.
- Виды документов, статусы и виды проблем helpdesk, состояния техники — справочники в базе, не константы в коде.
- В `docs`: ограничения доступа (`docTypes`, `folderIds`) применять через `server/docs/access.js` во всех запросах,
  включая счётчики; документы «без папки» ограниченному пользователю недоступны.

## Что не сделано / на что обратить внимание

- Портал ни разу не проверялся разработчиком на Windows и в настоящем Firefox 52 — только на Linux и в эмуляции.
  Внешний вид сайта заявок в Firefox 52 пользователь ещё не подтверждал.
- Жалоба «документы загружаются не полностью» на обычных PDF/DOCX не воспроизвелась; добавлены постраничный разбор,
  предупреждение о сканах и «Открыть оригинал». Если повторится — попросить файл-пример.
- Распознавание сканов PDF (OCR) — `server/docs/ocr.js`: картинки страниц достаёт pdf.js из pdf-parse (v2.0.550,
  `nativeImageDecoderSupport: 'none'`), распознаёт tesseract.js 7 + `@tesseract.js-data/rus|eng` (словари копируются
  в `%TEMP%\it-portal-tessdata`), очередь — `document_files.ocr_status`, один документ за раз. Пользователь говорил,
  что «раньше распознавание работало» (видимо, в прежней программе docsearch) — в этом репозитории его не было.
  Повёрнутые на 90° сканы не выравниваются (нет osd) — если пожалуются, добавить определение ориентации.
- Компоненты распознавания (tesseract.js + словари) **едут в архиве обновления** внутри `server/vendor/ocr`
  (`scripts/vendor-ocr.js`, вызывается из `make-update.sh`; в git не хранятся — `.gitignore`). Отдельный архив
  `node_modules` пользователь ставил неверно (компонентов в C:\it-portal не оказалось), поэтому так.
  `server/docs/ocr.js` ищет их в `node_modules`, затем в `server/vendor/ocr/node_modules` и во «вложенных» папках.
  Ядра tesseract-core нужны все варианты: на Node 22 выбирался relaxedsimd без LSTM.
- Название сайта заявок («HelpDesk») зашито в `public/helpdesk/app.js`; предлагалось вынести в настройки.
- Основной веткой репозитория на GitHub должна быть `main` (Settings → General → Default branch).
