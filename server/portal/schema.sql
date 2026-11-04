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

-- pg_trgm нужен реестру документов; ставим в public, чтобы он был виден всем модулям
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
