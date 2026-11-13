-- ============================================================
--  IT Inventory DB — схема PostgreSQL
--  Скрипт идемпотентный: можно запускать повторно.
-- ============================================================

-- Пользователи системы
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('superadmin','editor','reader')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Права читателя: {types:[id]|null, departments:[id]|null, fields:[key]|null,
  --                  passwords:bool, software:bool, export:bool}
  permissions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ
);

-- Типы техники (ПК, принтер, сервер, МФУ, ...)
CREATE TABLE IF NOT EXISTS device_types (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  code    TEXT NOT NULL UNIQUE,          -- префикс ключа, как в Jira: PC-12
  color   TEXT NOT NULL DEFAULT '#0052CC',
  -- какие базовые поля показывать для этого типа
  fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort    INT NOT NULL DEFAULT 0
);

-- Виды справочников (модели, сотрудники, отделы, процессоры, ...)
CREATE TABLE IF NOT EXISTS lookup_kinds (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  sort      INT NOT NULL DEFAULT 0
);

-- Значения справочников
CREATE TABLE IF NOT EXISTS lookups (
  id    SERIAL PRIMARY KEY,
  kind  TEXT NOT NULL REFERENCES lookup_kinds(code) ON DELETE CASCADE ON UPDATE CASCADE,
  value TEXT NOT NULL,
  note  TEXT,
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS lookups_kind_idx ON lookups(kind);

-- Техника
CREATE TABLE IF NOT EXISTS devices (
  id            SERIAL PRIMARY KEY,
  type_id       INT NOT NULL REFERENCES device_types(id),
  inv_number    TEXT,
  hostname      TEXT,
  model_id      INT REFERENCES lookups(id) ON DELETE SET NULL,
  cpu_id        INT REFERENCES lookups(id) ON DELETE SET NULL,
  ram_id        INT REFERENCES lookups(id) ON DELETE SET NULL,
  storage_id    INT REFERENCES lookups(id) ON DELETE SET NULL,
  os_id         INT REFERENCES lookups(id) ON DELETE SET NULL,
  employee_id   INT REFERENCES lookups(id) ON DELETE SET NULL,
  department_id INT REFERENCES lookups(id) ON DELETE SET NULL,
  location_id   INT REFERENCES lookups(id) ON DELETE SET NULL,
  serial_number TEXT,
  ip_address    TEXT,
  mac_address   TEXT,
  specs         TEXT,        -- прочие характеристики (свободный текст)
  status        TEXT NOT NULL DEFAULT 'in_use',   -- ключ из device_statuses
  notes         TEXT,
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- значения доп. полей {"<field_id>": "value"}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS devices_type_idx   ON devices(type_id);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status);
CREATE INDEX IF NOT EXISTS devices_dept_idx   ON devices(department_id);
CREATE INDEX IF NOT EXISTS devices_emp_idx    ON devices(employee_id);

-- Состояния техники (редактируются в «Настройки → Состояния»)
CREATE TABLE IF NOT EXISTS device_statuses (
  key   TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8993A4',
  sort  INT NOT NULL DEFAULT 0
);

-- В старых версиях список состояний был зашит ограничением — снимаем его
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;

-- Пароли / учётные данные устройства (секрет хранится зашифрованным AES-256-GCM)
CREATE TABLE IF NOT EXISTS device_credentials (
  id         SERIAL PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,           -- "Локальный администратор", "BIOS", "Web-интерфейс"
  login      TEXT,
  secret_enc TEXT NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT REFERENCES users(id) ON DELETE SET NULL
);

-- Справочник ПО
CREATE TABLE IF NOT EXISTS software (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  vendor TEXT
);

-- ПО, установленное на устройстве
CREATE TABLE IF NOT EXISTS device_software (
  id           SERIAL PRIMARY KEY,
  device_id    INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  software_id  INT NOT NULL REFERENCES software(id) ON DELETE CASCADE,
  version      TEXT,
  license_key  TEXT,
  installed_at DATE,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS device_software_dev_idx ON device_software(device_id);
CREATE INDEX IF NOT EXISTS device_software_sw_idx  ON device_software(software_id);

-- Дополнительные поля для ПО:
--   target = 'software' — для программы в справочнике (общие для всех установок: тип лицензии, договор…)
--   target = 'install'  — для установки на конкретном устройстве (срок лицензии, кто установил…)
CREATE TABLE IF NOT EXISTS software_field_defs (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  field_type  TEXT NOT NULL DEFAULT 'text'
              CHECK (field_type IN ('text','textarea','number','date','bool','select','lookup')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  lookup_kind TEXT REFERENCES lookup_kinds(code) ON DELETE SET NULL ON UPDATE CASCADE,
  target      TEXT NOT NULL CHECK (target IN ('software','install')),
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  INT REFERENCES users(id) ON DELETE SET NULL
);
-- Значения доп. полей ПО {"<field_id>": "value"}
ALTER TABLE software        ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE device_software ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Дополнительные поля.
--   scope = 'all'    — для всей техники
--   scope = 'type'   — для всех устройств типа type_id
--   scope = 'device' — только для одного экземпляра device_id
CREATE TABLE IF NOT EXISTS field_defs (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  field_type  TEXT NOT NULL DEFAULT 'text'
              CHECK (field_type IN ('text','textarea','number','date','bool','select','lookup')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- варианты для select
  lookup_kind TEXT REFERENCES lookup_kinds(code) ON DELETE SET NULL ON UPDATE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('all','type','device')),
  type_id     INT REFERENCES device_types(id) ON DELETE CASCADE,
  device_id   INT REFERENCES devices(id) ON DELETE CASCADE,
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((scope = 'all'    AND type_id IS NULL AND device_id IS NULL) OR
         (scope = 'type'   AND type_id IS NOT NULL AND device_id IS NULL) OR
         (scope = 'device' AND device_id IS NOT NULL))
);

-- История изменений (лента активности на странице устройства)
CREATE TABLE IF NOT EXISTS device_history (
  id         BIGSERIAL PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  changes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_history_dev_idx ON device_history(device_id, created_at DESC);

-- Запомненные соответствия «название колонки в Excel → поле на сайте» для импорта
CREATE TABLE IF NOT EXISTS import_mappings (
  header     TEXT PRIMARY KEY,        -- нормализованное название колонки
  target     TEXT NOT NULL,           -- ключ поля на сайте или 'skip'
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сохранённые фильтры (выборки)
CREATE TABLE IF NOT EXISTS saved_filters (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сессии (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ------------------------------------------------------------
-- Начальные справочники
-- ------------------------------------------------------------
INSERT INTO lookup_kinds (code, name, is_system, sort) VALUES
  ('model',      'Модели',          TRUE, 1),
  ('employee',   'Сотрудники',      TRUE, 2),
  ('department', 'Отделы',          TRUE, 3),
  ('location',   'Расположение',    TRUE, 4),
  ('cpu',        'Процессоры',      TRUE, 5),
  ('ram',        'Оперативная память', TRUE, 6),
  ('storage',    'Накопители',      TRUE, 7),
  ('os',         'Операционные системы', TRUE, 8)
ON CONFLICT (code) DO NOTHING;

-- Стандартные типы добавляются только в пустую базу
INSERT INTO device_types (name, code, color, sort, fields)
SELECT v.name, v.code, v.color, v.sort, v.fields::jsonb FROM (VALUES
  ('ПК',       'PC',  '#0052CC', 1, '["inv_number","hostname","model","cpu","ram","storage","os","employee","department","location","serial_number","ip_address","mac_address","specs"]'),
  ('Ноутбук',  'NB',  '#00A3BF', 2, '["inv_number","hostname","model","cpu","ram","storage","os","employee","department","location","serial_number","ip_address","mac_address","specs"]'),
  ('Сервер',   'SRV', '#6554C0', 3, '["inv_number","hostname","model","cpu","ram","storage","os","department","location","serial_number","ip_address","mac_address","specs"]'),
  ('Принтер',  'PRN', '#FF8B00', 4, '["inv_number","hostname","model","employee","department","location","serial_number","ip_address","mac_address","specs"]'),
  ('МФУ',      'MFU', '#36B37E', 5, '["inv_number","hostname","model","employee","department","location","serial_number","ip_address","mac_address","specs"]'),
  ('Прочее',   'OTH', '#8993A4', 9, '["inv_number","hostname","model","employee","department","location","serial_number","ip_address","mac_address","specs"]')) AS v(name, code, color, sort, fields)
WHERE NOT EXISTS (SELECT 1 FROM device_types);

-- Стандартные состояния добавляются только в пустую таблицу
INSERT INTO device_statuses (key, label, color, sort)
SELECT v.key, v.label, v.color, v.sort FROM (VALUES
  ('in_use',      'Используется', '#36B37E', 1),
  ('broken',      'Сломано',      '#DE350B', 2),
  ('written_off', 'Списано',      '#8993A4', 3)) AS v(key, label, color, sort)
WHERE NOT EXISTS (SELECT 1 FROM device_statuses);

-- Если у устройства оказалось состояние, которого нет в справочнике, — добавляем его, чтобы ничего не потерялось
INSERT INTO device_statuses (key, label, sort)
SELECT DISTINCT d.status, d.status, 100 FROM devices d
WHERE NOT EXISTS (SELECT 1 FROM device_statuses s WHERE s.key = d.status)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Рабочие места: к рабочему месту привязывается любая техника в любом количестве
-- (одна единица техники стоит не более чем на одном рабочем месте)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workplaces (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  employee_id   INT REFERENCES lookups(id) ON DELETE SET NULL,
  department_id INT REFERENCES lookups(id) ON DELETE SET NULL,
  location_id   INT REFERENCES lookups(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INT REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS workplace_id INT REFERENCES workplaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS devices_workplace_idx ON devices(workplace_id);

-- ------------------------------------------------------------
-- Сведения из сети (Active Directory, WMI, SNMP, сетевые проверки)
-- ------------------------------------------------------------
-- Настройки опроса — одна строка; задаёт администратор портала. Пароль зашифрован APP_SECRET_KEY.
CREATE TABLE IF NOT EXISTS netprobe_settings (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ad_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  wmi_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  snmp_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  ad_server        TEXT NOT NULL DEFAULT '',
  ad_base_dn       TEXT NOT NULL DEFAULT '',
  username         TEXT NOT NULL DEFAULT '',
  password_enc     TEXT,
  snmp_communities TEXT NOT NULL DEFAULT 'public',
  updated_at       TIMESTAMPTZ,
  updated_by       INT REFERENCES users(id) ON DELETE SET NULL
);
-- Последние полученные сведения об устройстве
CREATE TABLE IF NOT EXISTS device_netinfo (
  device_id    INT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  data         JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_by INT REFERENCES users(id) ON DELETE SET NULL
);

-- Справочники: полное и короткое название (используются у «Отделов», поиск идёт по всем трём полям)
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS short_name TEXT;

-- ------------------------------------------------------------
-- Сканирование сети: какие сети сканировать по умолчанию, результат последнего сканирования, скрытые устройства
-- ------------------------------------------------------------
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS scan_networks TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS netscan_last (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  networks    TEXT NOT NULL DEFAULT '',
  ranges      JSONB NOT NULL DEFAULT '[]'::jsonb,
  hosts       JSONB NOT NULL DEFAULT '[]'::jsonb,
  scanned_by  INT REFERENCES users(id) ON DELETE SET NULL
);
-- Устройства, которые не нужно предлагать (телефоны, гостевые ноутбуки…): ключ «mac:…» или «ip:…»
CREATE TABLE IF NOT EXISTS netscan_ignore (
  key        TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Шаблоны значений для карточки (процессор, память…) и замены «из сети → как в базе»
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS formats JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS netprobe_replacements (
  id         SERIAL PRIMARY KEY,
  field      TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS netprobe_replacements_uq ON netprobe_replacements (field, lower(src));

-- Найденная при сканировании техника, по которой ещё не принято решение (новая или с отличиями от карточки).
-- Копится между сканированиями; решённое (state = 'done') возвращается, только если изменились отличия (handled_sig).
CREATE TABLE IF NOT EXISTS netscan_hosts (
  key            TEXT PRIMARY KEY,
  host           JSONB NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending',
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_sig    TEXT,
  handled_action TEXT,
  handled_by     INT REFERENCES users(id) ON DELETE SET NULL,
  handled_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS netscan_hosts_state_idx ON netscan_hosts (state);

-- Уведомления: личные настройки пользователя ({"printer_supplies": false} — не показывать о расходниках)
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Расходники принтеров и МФУ (опрос по SNMP по расписанию); порог предупреждения — в настройках
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS supply_threshold INT NOT NULL DEFAULT 15;
CREATE TABLE IF NOT EXISTS printer_supplies (
  device_id  INT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  supplies   JSONB NOT NULL DEFAULT '[]'::jsonb,
  model      TEXT,
  error      TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Когда техника последний раз отвечала в сети (сканирование, «Сведения из сети», опрос принтеров) — для уведомления «давно не в сети»
CREATE TABLE IF NOT EXISTS device_seen (
  device_id INT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сканирование сети по расписанию: {"mode":"off|daily|weekly","time":"02:00","weekday":1,"wmi":false}
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS scan_schedule JSONB NOT NULL DEFAULT '{"mode":"off"}'::jsonb;
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS scan_last_auto TIMESTAMPTZ;

-- Инвентаризация: плановая проверка наличия техники на дату
CREATE TABLE IF NOT EXISTS inventory_audits (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  planned_date DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  filters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  note         TEXT NOT NULL DEFAULT '',
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  finished_by  INT REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS inventory_audit_items (
  audit_id   INT NOT NULL REFERENCES inventory_audits(id) ON DELETE CASCADE,
  device_id  INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'found', 'missing', 'moved')),
  note       TEXT NOT NULL DEFAULT '',
  snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_by INT REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  PRIMARY KEY (audit_id, device_id)
);

-- Кнопка «Подключиться к сеансу» в карточке техники: {"enabled":true,"control":true,"consent":true}
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS remote_connect JSONB NOT NULL DEFAULT '{"enabled":true,"control":true,"consent":true}'::jsonb;

-- Перемещения техники: куда, кому, когда и почему (имена сохраняются — отчёт не меняется при правке справочников)
CREATE TABLE IF NOT EXISTS device_moves (
  id         BIGSERIAL PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  moved_on   DATE NOT NULL DEFAULT current_date,
  changes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  note       TEXT NOT NULL DEFAULT '',
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_moves_device_idx ON device_moves (device_id, moved_on DESC);
CREATE INDEX IF NOT EXISTS device_moves_date_idx ON device_moves (moved_on DESC);

-- Итог последнего сканирования по расписанию: { at, ok, error, found, fresh }
ALTER TABLE netprobe_settings ADD COLUMN IF NOT EXISTS scan_last_auto_result JSONB;
