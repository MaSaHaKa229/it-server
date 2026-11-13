-- Удалённый доступ (агенты «ИТ Удалённый доступ», журнал подключений). Схема remote. Скрипт идемпотентный.
-- Все имена — с явной схемой: если схемы ещё нет, search_path молча направил бы таблицы в public.
CREATE SCHEMA IF NOT EXISTS remote;

-- Агенты на компьютерах пользователей
CREATE TABLE IF NOT EXISTS remote.agents (
  id             UUID PRIMARY KEY,                       -- agent_id из agent.conf
  key_hash       TEXT NOT NULL,                          -- SHA-256 ключа агента (сам ключ знает только агент)
  computer_name  TEXT NOT NULL,
  os             TEXT,
  version        TEXT,
  port           INT NOT NULL DEFAULT 5960,
  fingerprint    TEXT,                                   -- отпечаток TLS-сертификата агента (SHA-256, hex)
  ips            TEXT[] NOT NULL DEFAULT '{}',
  macs           TEXT[] NOT NULL DEFAULT '{}',           -- 12 hex-символов, нижний регистр
  seen_ip        TEXT,                                   -- адрес, с которого агент обращался к серверу
  windows_user   TEXT,
  device_id      INT REFERENCES public.devices(id) ON DELETE SET NULL,
  device_manual  BOOLEAN NOT NULL DEFAULT FALSE,         -- привязку менял администратор — автоматически не трогаем
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_device_idx ON remote.agents (device_id);
CREATE INDEX IF NOT EXISTS agents_name_idx ON remote.agents (lower(computer_name));

-- Журнал подключений
CREATE TABLE IF NOT EXISTS remote.sessions (
  id             UUID PRIMARY KEY,
  agent_id       UUID REFERENCES remote.agents(id) ON DELETE SET NULL,
  computer_name  TEXT NOT NULL,                          -- копия на случай удаления агента
  device_id      INT REFERENCES public.devices(id) ON DELETE SET NULL,
  user_id        INT REFERENCES public.users(id) ON DELETE SET NULL,
  user_name      TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('control', 'view')),
  consent        TEXT NOT NULL CHECK (consent IN ('ask', 'notify', 'none')),
  ticket_id      INT,                                    -- заявка helpdesk, из которой подключились
  status         TEXT NOT NULL DEFAULT 'issued',         -- issued, opened, started, ended, denied, no_answer, failed
  viewer_ticket_hash TEXT,                               -- одноразовый пропуск просмотрщика (SHA-256)
  viewer_ip      TEXT,
  windows_user   TEXT,
  detail         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  opened_at      TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON remote.sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_agent_idx ON remote.sessions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON remote.sessions (user_id, created_at DESC);

-- Настройки и ключ подписи пропусков
CREATE TABLE IF NOT EXISTS remote.settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Удалённая установка программы специалиста на компьютеры ИТ-отдела
CREATE TABLE IF NOT EXISTS remote.installs (
  id             SERIAL PRIMARY KEY,
  user_id        INT REFERENCES public.users(id) ON DELETE SET NULL,   -- специалист
  user_name      TEXT NOT NULL,
  computer       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',                      -- running, ok, failed
  steps          JSONB NOT NULL DEFAULT '[]'::jsonb,                    -- ход установки (без пароля)
  os             TEXT,
  version        TEXT,
  started_by     INT REFERENCES public.users(id) ON DELETE SET NULL,
  started_by_name TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS installs_user_idx ON remote.installs (user_id, created_at DESC);
-- Установки, прерванные перезапуском портала, не должны «висеть» в состоянии «идёт»
UPDATE remote.installs SET status = 'failed', finished_at = now(),
       steps = steps || '[{"step":"error","state":"fail","text":"Портал был перезапущен во время установки — повторите"}]'::jsonb
 WHERE status = 'running';
