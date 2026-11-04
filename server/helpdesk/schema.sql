-- Helpdesk: заявки сотрудников в ИТ-отдел (схема helpdesk). Скрипт идемпотентный.

-- Сотрудники предприятия, зарегистрированные по внутренней почте
CREATE TABLE IF NOT EXISTS requesters (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  department     TEXT,
  position       TEXT,
  phone          TEXT,
  room           TEXT,
  password_hash  TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,      -- блокировка администратором
  is_approved    BOOLEAN NOT NULL DEFAULT TRUE,      -- подтверждение регистрации администратором
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,     -- подтверждение по коду из письма
  verify_code    TEXT,
  verify_expires TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS requesters_email_idx ON requesters (lower(email));

-- Виды проблем (поломок)
CREATE TABLE IF NOT EXISTS categories (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  description         TEXT,
  icon                TEXT NOT NULL DEFAULT '🛠',
  sort                INT NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  default_assignee_id INT REFERENCES public.users(id) ON DELETE SET NULL,
  sla_hours           INT CHECK (sla_hours IS NULL OR sla_hours > 0)   -- срок выполнения по умолчанию
);

-- Статусы заявки
CREATE TABLE IF NOT EXISTS statuses (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#8993A4',
  sort       INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,   -- присваивается новой заявке
  is_closed  BOOLEAN NOT NULL DEFAULT FALSE    -- заявка считается закрытой
);

-- Заявки
CREATE TABLE IF NOT EXISTS tickets (
  id           SERIAL PRIMARY KEY,
  requester_id INT NOT NULL REFERENCES requesters(id) ON DELETE CASCADE,
  category_id  INT REFERENCES categories(id) ON DELETE SET NULL,
  status_id    INT NOT NULL REFERENCES statuses(id),
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  location     TEXT,                                                -- кабинет / рабочее место
  device_id    INT REFERENCES public.devices(id) ON DELETE SET NULL, -- связанная техника из инвентаря
  assignee_id  INT REFERENCES public.users(id) ON DELETE SET NULL,   -- исполнитель (сотрудник ИТ)
  due_at       TIMESTAMPTZ,                                         -- срок выполнения
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_requester_idx ON tickets (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_status_idx    ON tickets (status_id);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx  ON tickets (assignee_id);

-- Комментарии: от заявителя или от сотрудника ИТ (внутренние комментарии заявитель не видит)
CREATE TABLE IF NOT EXISTS comments (
  id           SERIAL PRIMARY KEY,
  ticket_id    INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  requester_id INT REFERENCES requesters(id) ON DELETE SET NULL,
  user_id      INT REFERENCES public.users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_ticket_idx ON comments (ticket_id, created_at);

-- Вложения (фото, скриншоты, документы)
CREATE TABLE IF NOT EXISTS attachments (
  id           SERIAL PRIMARY KEY,
  ticket_id    INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id   INT REFERENCES comments(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         INT NOT NULL,
  data         BYTEA NOT NULL,
  requester_id INT REFERENCES requesters(id) ON DELETE SET NULL,
  user_id      INT REFERENCES public.users(id) ON DELETE SET NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_ticket_idx ON attachments (ticket_id);

-- История изменений заявки
CREATE TABLE IF NOT EXISTS history (
  id           BIGSERIAL PRIMARY KEY,
  ticket_id    INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id      INT REFERENCES public.users(id) ON DELETE SET NULL,
  requester_id INT REFERENCES requesters(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS history_ticket_idx ON history (ticket_id, created_at);

-- Настройки helpdesk (домены почты, подтверждение регистрации и т.п.)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Сессии сотрудников на сайте заявок (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "hd_session_expire_idx" ON "session" ("expire");

-- ------------------------------------------------------------
-- Начальные данные (только в пустые таблицы)
-- ------------------------------------------------------------
INSERT INTO statuses (name, color, sort, is_default, is_closed)
SELECT v.name, v.color, v.sort, v.is_default, v.is_closed FROM (VALUES
  ('Новая',                  '#0052CC', 1, TRUE,  FALSE),
  ('В работе',               '#FF8B00', 2, FALSE, FALSE),
  ('Ожидает ответа',         '#6554C0', 3, FALSE, FALSE),
  ('Выполнена',              '#36B37E', 4, FALSE, TRUE),
  ('Отклонена',              '#8993A4', 5, FALSE, TRUE)) AS v(name, color, sort, is_default, is_closed)
WHERE NOT EXISTS (SELECT 1 FROM statuses);

INSERT INTO categories (name, description, icon, sort)
SELECT v.name, v.description, v.icon, v.sort FROM (VALUES
  ('Принтер / МФУ',          'Не печатает, замятие бумаги, закончился картридж, не сканирует', '🖨', 1),
  ('Компьютер / ноутбук',    'Не включается, шумит, медленно работает, синий экран',           '💻', 2),
  ('Программа / приложение', 'Ошибка в программе, не запускается, нужна установка или обновление', '🧩', 3),
  ('Сеть и интернет',        'Нет сети, не открываются сайты, не работает Wi-Fi',              '🌐', 4),
  ('Учётная запись и доступ','Забыл пароль, нужен доступ к папке или системе',                 '🔑', 5),
  ('Почта',                  'Не приходят или не отправляются письма',                          '✉', 6),
  ('Телефония',              'Не работает рабочий телефон',                                    '☎', 7),
  ('Другое',                 'Всё, что не подошло под другие виды',                            '❓', 99)) AS v(name, description, icon, sort)
WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT INTO settings (key, value) VALUES
  ('allowed_domains',  '[]'::jsonb),
  ('require_approval', 'false'::jsonb),
  ('welcome_text',     '"Опишите проблему — специалисты ИТ-отдела возьмут заявку в работу и сообщат о результате."'::jsonb)
ON CONFLICT (key) DO NOTHING;
