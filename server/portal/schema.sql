-- Дополнения портала к таблице пользователей ИТ-инвентаря (схема public).
-- Скрипт идемпотентный.

-- Доступ к модулям портала:
--   {"inventory":"none|view|edit", "docs":"none|view|edit", "docs_types":[...]|null,
--    "calendar":"none|view|edit|admin", "calendar_own_only":bool, "helpdesk":"none|executor|admin"}
ALTER TABLE users ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Пользователи, созданные до объединения, сохраняют доступ к инвентарю согласно своей роли
UPDATE users
   SET modules = jsonb_build_object('inventory', CASE role WHEN 'reader' THEN 'view' ELSE 'edit' END)
 WHERE modules = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Схемы модулей
CREATE SCHEMA IF NOT EXISTS docs;
CREATE SCHEMA IF NOT EXISTS calendar;
CREATE SCHEMA IF NOT EXISTS helpdesk;

-- Настройки портала (почта и т. п.): ключ → значение
CREATE TABLE IF NOT EXISTS portal_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Уведомления (колокольчик): события — заявки, задачи, найденная техника. Вычисляемые (сроки, расходники,
-- гарантия) в таблице не хранятся — считаются при запросе (server/portal/notify.js)
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- Какие вычисляемые уведомления уже отправлены на почту (чтобы не слать повторно)
CREATE TABLE IF NOT EXISTS notify_sent (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Журнал входов и действий администраторов
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT,
  action     TEXT NOT NULL,
  object     TEXT,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

-- Сохранённые фильтры (заявки, задачи): у каждого свои, можно сделать общими
CREATE TABLE IF NOT EXISTS saved_views (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section    TEXT NOT NULL,
  name       TEXT NOT NULL,
  params     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_views_idx ON saved_views (section, user_id);

-- Избранное и недавно открытое (техника, заявки, задачи, документы, рабочие места)
CREATE TABLE IF NOT EXISTS user_items (
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  ref       TEXT NOT NULL,
  title     TEXT NOT NULL,
  link      TEXT NOT NULL,
  favorite  BOOLEAN NOT NULL DEFAULT false,
  viewed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS user_items_viewed_idx ON user_items (user_id, viewed_at DESC);

-- pg_trgm нужен реестру документов; ставим в public, чтобы он был виден всем модулям
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
