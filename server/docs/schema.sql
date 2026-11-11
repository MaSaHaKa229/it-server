-- Схема БД. Выполняется при каждом старте сервера (идемпотентно).

-- Расширение pg_trgm устанавливается порталом (server/portal/schema.sql)

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  full_name     VARCHAR(200) NOT NULL DEFAULT '',
  role          VARCHAR(20)  NOT NULL DEFAULT 'reader'
                CHECK (role IN ('superadmin', 'editor', 'reader')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  title       TEXT         NOT NULL,
  doc_type    VARCHAR(40)  NOT NULL DEFAULT 'other',
  number      VARCHAR(100) NOT NULL DEFAULT '',
  adopted_at  DATE,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive', 'draft')),
  content     TEXT         NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Полнотекстовые индексы (русская морфология): отдельно по названию/номеру и по тексту
  title_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('russian', title || ' ' || number)) STORED,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian', content)) STORED
);

CREATE INDEX IF NOT EXISTS documents_title_tsv_idx   ON documents USING GIN (title_tsv);
CREATE INDEX IF NOT EXISTS documents_content_tsv_idx ON documents USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS documents_title_trgm_idx  ON documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_number_trgm_idx ON documents USING GIN (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_type_idx        ON documents (doc_type);
CREATE INDEX IF NOT EXISTS documents_updated_idx     ON documents (updated_at DESC);

-- Оригинал загруженного файла (PDF, DOCX, TXT)
CREATE TABLE IF NOT EXISTS document_files (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  filename    TEXT        NOT NULL,
  mime_type   TEXT        NOT NULL,
  size        INTEGER     NOT NULL,
  data        BYTEA       NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ссылки между документами (строятся автоматически из текста: [текст](doc:ID))
CREATE TABLE IF NOT EXISTS document_links (
  source_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX IF NOT EXISTS document_links_target_idx ON document_links (target_id);

-- История изменений: предыдущие версии документа
CREATE TABLE IF NOT EXISTS document_versions (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER     NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  doc_type    VARCHAR(40) NOT NULL,
  number      VARCHAR(100) NOT NULL DEFAULT '',
  adopted_at  DATE,
  status      VARCHAR(20) NOT NULL,
  content     TEXT        NOT NULL,
  edited_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  edited_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS document_versions_doc_idx ON document_versions (document_id, edited_at DESC);

-- Виды документов (справочник; добавляются редакторами и администратором)
CREATE TABLE IF NOT EXISTS doc_types (
  code       VARCHAR(40)  PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  color      VARCHAR(7)   NOT NULL DEFAULT '#6B778C',
  sort       INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO doc_types (code, name, color, sort) VALUES
  ('law',        'Закон',     '#0052CC', 1),
  ('gost',       'ГОСТ',      '#00875A', 2),
  ('decree',     'Указ',      '#FF8B00', 3),
  ('regulation', 'Регламент', '#5243AA', 4),
  ('other',      'Прочее',    '#6B778C', 99)
ON CONFLICT (code) DO NOTHING;
-- Виды, которые уже встречаются в документах, но отсутствуют в справочнике
INSERT INTO doc_types (code, name, sort)
SELECT DISTINCT d.doc_type, d.doc_type, 100 FROM documents d
 WHERE NOT EXISTS (SELECT 1 FROM doc_types t WHERE t.code = d.doc_type)
ON CONFLICT DO NOTHING;
-- Раньше список видов был зашит ограничением — теперь он берётся из справочника
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_doc_type_check;
ALTER TABLE documents ALTER COLUMN doc_type TYPE VARCHAR(40);
ALTER TABLE document_versions ALTER COLUMN doc_type TYPE VARCHAR(40);
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_doc_type_fk
    FOREIGN KEY (doc_type) REFERENCES doc_types(code) ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- Папки (дерево) и теги
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folders (
  id         SERIAL PRIMARY KEY,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
  name       VARCHAR(200) NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_name_idx ON folders (COALESCE(parent_id, 0), lower(name));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder_id);

CREATE TABLE IF NOT EXISTS tags (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(60) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#6B778C'
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_idx ON tags (lower(name));
CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX IF NOT EXISTS document_tags_tag_idx ON document_tags (tag_id);

-- Сколько страниц в загруженном PDF и со скольких получен текст (для предупреждения о сканах)
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS pages INTEGER;
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS text_pages INTEGER;

-- Распознавание текста сканированных страниц PDF (OCR): pending → running → done / none / error / unavailable
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS ocr_status TEXT;
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS ocr_pages INTEGER[];
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS ocr_error TEXT;
ALTER TABLE document_files ADD COLUMN IF NOT EXISTS ocr_at TIMESTAMPTZ;

-- Суперадминистратор — служебная учётная запись: в списках людей не показывается,
-- вместо его имени в авторах и журналах пишется «Служба ИТ». Отметку ставит синхронизация пользователей.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users x SET is_system = (p.role = 'superadmin')
  FROM public.users p WHERE p.id = x.id AND x.is_system IS DISTINCT FROM (p.role = 'superadmin');
