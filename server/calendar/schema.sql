-- Схема базы данных календаря задач службы ИТ

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'viewer',
  position      TEXT,
  color         TEXT NOT NULL DEFAULT '#6366f1',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#0ea5e9',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ NOT NULL,
  all_day     BOOLEAN NOT NULL DEFAULT FALSE,
  status      task_status NOT NULL DEFAULT 'todo',
  priority    task_priority NOT NULL DEFAULT 'normal',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_period_chk CHECK (end_at >= start_at)
);
CREATE INDEX IF NOT EXISTS tasks_period_idx ON tasks (start_at, end_at);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_checklist (
  id       SERIAL PRIMARY KEY,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  done     BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC);

-- Задача, созданная автоматически из заявки helpdesk (номер заявки)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS helpdesk_ticket_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_helpdesk_ticket_idx ON tasks (helpdesk_ticket_id) WHERE helpdesk_ticket_id IS NOT NULL;

-- Доступ сотрудника к разделу «Задачи и календарь».
-- Исполнителем задачи можно назначить любого активного сотрудника портала (is_active),
-- даже без доступа к календарю (has_access = FALSE) — он просто не видит раздел.
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_access BOOLEAN NOT NULL DEFAULT TRUE;

-- Дата выполнения задачи (для статистики). Ставится автоматически при переходе в статус «Выполнено»
-- и очищается при выходе из него — триггер срабатывает и при изменениях из заявок helpdesk.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS tasks_completed_idx ON tasks (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees (user_id);

CREATE OR REPLACE FUNCTION task_set_completed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'done' THEN
    NEW.completed_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSIF OLD.status <> 'done' OR NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tasks_completed_at_trg'
                   AND tgrelid = 'tasks'::regclass) THEN
    CREATE TRIGGER tasks_completed_at_trg BEFORE INSERT OR UPDATE OF status, completed_at ON tasks
      FOR EACH ROW EXECUTE PROCEDURE task_set_completed_at();
  END IF;
END $$;

-- Задачи, выполненные до появления поля: дата из журнала (последний перевод в «Выполнено»), иначе — дата изменения
UPDATE tasks t SET completed_at = COALESCE(
    (SELECT max(a.created_at) FROM activity_log a
      WHERE a.entity = 'task' AND a.entity_id = t.id AND a.details->>'status' = 'done'),
    t.updated_at)
 WHERE t.status = 'done' AND t.completed_at IS NULL;

-- Периодические задачи (серии): ежемесячно, ежеквартально, раз в полгода, ежегодно.
-- По серии автоматически создаются обычные задачи-повторы (series_id, series_idx — номер повтора),
-- у каждого повтора свой статус, комментарии и чек-лист.
CREATE TABLE IF NOT EXISTS task_series (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  start_at     TIMESTAMPTZ NOT NULL,
  end_at       TIMESTAMPTZ NOT NULL,
  all_day      BOOLEAN NOT NULL DEFAULT FALSE,
  priority     task_priority NOT NULL DEFAULT 'normal',
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  every_months INTEGER NOT NULL DEFAULT 12,
  until        DATE,
  assignees    INTEGER[] NOT NULL DEFAULT '{}',
  checklist    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_series_period_chk CHECK (end_at >= start_at),
  CONSTRAINT task_series_every_chk CHECK (every_months IN (1, 3, 6, 12))
);
-- Удалённые по одному повторы — чтобы они не появились снова
CREATE TABLE IF NOT EXISTS task_series_skips (
  series_id INTEGER NOT NULL REFERENCES task_series(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  PRIMARY KEY (series_id, idx)
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS series_id INTEGER REFERENCES task_series(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS series_idx INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_series_occ_idx ON tasks (series_id, series_idx) WHERE series_id IS NOT NULL;

-- Отсутствия сотрудников: отпуск, больничный, командировка, отгул
CREATE TABLE IF NOT EXISTS absences (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'vacation',
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT absences_period_chk CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS absences_period_idx ON absences (start_date, end_date);
CREATE INDEX IF NOT EXISTS absences_user_idx ON absences (user_id);

-- Часовой пояс, в котором считаются даты повторов (пояс браузера автора серии)
ALTER TABLE task_series ADD COLUMN IF NOT EXISTS tz TEXT NOT NULL DEFAULT current_setting('TimeZone');

-- Настройки календаря (цвета видов отсутствий, приоритетов, статусов и т. п.)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Свой цвет задачи / регулярной задачи (иначе — по настройке раскраски)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE task_series ADD COLUMN IF NOT EXISTS color TEXT;
