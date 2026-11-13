# ИТ-портал — контекст проекта

Единый сайт ИТ-отдела предприятия: ИТ-инвентарь, документы, задачи с календарём, заявки (helpdesk).
Node.js (Express) + PostgreSQL. Описание возможностей — `README.md`, установка и обновление — `INSTALL.md`.
С пользователем общаемся **по-русски**; интерфейс, комментарии в коде, коммиты и PR — тоже на русском.

## Где это работает

- Сервер заказчика: **виртуальная машина Windows 11 без интернета**, папка `C:\it-portal`, PostgreSQL на той же машине
  (база `itdb`, в ней изначально был только ИТ-инвентарь с живыми данными — их нельзя терять).
- Запуск — задание Планировщика «IT Portal» (`scripts/install-autostart.ps1`), журнал `C:\it-portal\portal.log`.
- Перед порталом nginx (`scripts/nginx.conf`): `http://it-portal` → порт 3000, `http://helpdesk` и обращение по IP → порт 3100.
- Часть компьютеров сотрудников — Windows XP с **Firefox 52 ESR**: сайт заявок обязан в нём открываться.
- Всё должно работать офлайн: никаких CDN, внешних шрифтов и скриптов. Зависимости — только чистый JavaScript
  (без компилируемых модулей), чтобы `node_modules` переносилась между Linux и Windows.

## Архитектура

Один процесс Node.js (`server/index.js`), два порта:

| Порт | Что | Код |
|---|---|---|
| `PORT` (3000) | портал ИТ-отдела: `/`, `/admin`, `/inventory/`, `/docs/`, `/calendar/`, `/helpdesk/`, `/remote/` | `server/portal`, `server/inventory`, `server/docs`, `server/calendar` (ES-модули), `server/helpdesk/staff.js`, `server/remote` |
| `HELPDESK_PORT` (3100) | сайт заявок для всех сотрудников (+ `/remote/agent-api` для агентов, обращающихся по IP) | `server/helpdesk/public.js` |

Одна база, схемы: `public` — инвентарь и пользователи портала, `docs`, `calendar`, `helpdesk`, `remote`
(`server/db.js`: `poolFor(schema)` ставит `search_path`). Миграции — идемпотентные `schema.sql` в каждом модуле,
выполняются **при каждом запуске** (`server/setup.js`). Новые изменения схемы — только через
`CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` в конце соответствующего `schema.sql`.

**Пользователи и права.** Источник истины — `public.users` (таблица инвентаря): `role` (`superadmin` — администратор
портала; `editor`/`reader` — уровень в инвентаре), `permissions` (тонкие права читателя инвентаря), `modules` (JSONB):
`inventory`, `docs`, `calendar`, `helpdesk`, `remote` — уровни из `server/portal/modules.js`; плюс `docs_types`, `docs_folders`,
`calendar_own_only`. Сессия общая (cookie `itdb.sid`, express-session в PostgreSQL). `server/portal/sync.js` копирует
пользователей в `docs.users` и `calendar.users` с теми же id (нужны для связей «автор», «исполнитель»).
Заявители helpdesk — отдельная таблица `helpdesk.requesters` и своя сессия (`helpdesk.sid`).

Все права проверяются на сервере. Изменяющие запросы к API требуют заголовок `X-Requested-With` (защита от CSRF).

**Связи между модулями:**
- заявка helpdesk ↔ задача календаря (`server/helpdesk/calendar-sync.js`, односторонняя синхронизация из заявки);
- заявка → техника инвентаря (`tickets.device_id`);
- срок заявки выставляет только администратор helpdesk при назначении исполнителя;
- удалённый доступ: агент ↔ техника (`remote.agents.device_id`), подключение из заявки → `helpdesk.history` (action `remote`).

**Удалённый доступ (`server/remote`).** Программы — в репозитории `RemoteSupport` (агент C++ для XP…11, просмотрщик .NET),
протокол и HTTP-API агентов — его `protocol/PROTOCOL.md`. Портал: агенты регистрируются кодом (`/remote/agent-api/register`),
шлют пульс раз в 30 с; «Подключиться» → `POST /remote/api/sessions` → ссылка `itremote://connect?server&session&token` →
просмотрщик меняет одноразовый пропуск на адрес, отпечаток сертификата агента и подписанный ECDSA P-256 токен
(`POST /remote/api/connect`, без сессии, заголовок `X-Requested-With: ITRemoteViewer`). Ключ подписи — `remote.settings`,
зашифрован `APP_SECRET_KEY`. Кнопка для страниц — `public/shared/remote.js`. Программы для скачивания (`public/remote/downloads/*.exe`)
в git не хранятся: `scripts/make-update.sh` берёт их из `../RemoteSupport-/dist` (или `REMOTE_DIST`) — перед архивом соберите RemoteSupport (`./build.sh`).

## Интерфейсы

| Раздел | Технология | Исходники | Что отдаётся |
|---|---|---|---|
| Портал (главная, вход, админка), заявки ИТ-отдела, сайт заявок, инвентарь | чистый JS, ES-модули, без сборки | `public/portal`, `public/helpdesk-staff`, `public/helpdesk`, `public/inventory`, `public/shared` | те же файлы |
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
- Распознавание текста на сканах (OCR) не реализовано.
- Название сайта заявок («HelpDesk») зашито в `public/helpdesk/app.js`; предлагалось вынести в настройки.
- Удалённый доступ (этап 3 из `RemoteSupport/PROMPT.md`) проверен только в Linux и под Wine; ретранслятор для недоступных
  напрямую компьютеров (этап 6), буфер обмена, файлы, чат (этап 4) и инструменты администратора (этап 5) не сделаны.
- Основной веткой репозитория на GitHub должна быть `main` (Settings → General → Default branch).
