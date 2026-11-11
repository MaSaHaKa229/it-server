const express = require('express');
const multer = require('multer');
const { query, withTx } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { extractFile, fixFilename, ALLOWED_EXT } = require('../extract');
const ocr = require('../ocr');
const { visibleConds, canSeeDoc } = require('../access');
const { ah, httpError, parseId, STATUSES, EDITORS } = require('../utils');

const router = express.Router();
router.use(requireAuth);

const MAX_FILE = 50 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, fieldSize: MAX_FILE },
  fileFilter: (req, file, cb) => {
    file.originalname = fixFilename(file.originalname);
    const ok = ALLOWED_EXT.some((ext) => file.originalname.toLowerCase().endsWith(ext));
    cb(ok ? null : httpError(400, `Допустимые форматы: ${ALLOWED_EXT.join(', ')}`), ok);
  },
});

// Ссылка на документ в тексте: [любой текст](doc:123)
const LINK_RE = /\]\(doc:(\d+)\)/g;

function parseDocFields(body) {
  const title = String(body.title || '').trim();
  if (!title) throw httpError(400, 'Укажите название документа');
  if (title.length > 2000) throw httpError(400, 'Слишком длинное название');
  const adopted_at = String(body.adopted_at || '').trim() || null;
  if (adopted_at && !/^\d{4}-\d{2}-\d{2}$/.test(adopted_at)) {
    throw httpError(400, 'Некорректная дата принятия');
  }
  return {
    title,
    doc_type: String(body.doc_type || 'other').slice(0, 40),
    number: String(body.number || '').trim().slice(0, 100),
    adopted_at,
    status: STATUSES.includes(body.status) ? body.status : 'active',
    content: String(body.content ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n'),
    folder_id: body.folder_id && Number(body.folder_id) > 0 ? Number(body.folder_id) : null,
    tags: parseTags(body.tags),
  };
}

/* ---------- Ограничение по видам документов (задаётся администратором портала) ---------- */
/* ---------- Доступ: виды документов и папки (задаёт администратор портала) ---------- */
async function assertVisible(req, id) {
  if (!req.user.docTypes && !req.user.folderIds) return;
  const { rows } = await query('SELECT doc_type, folder_id FROM documents WHERE id = $1', [id]);
  if (!rows[0] || !canSeeDoc(req.user, rows[0])) throw httpError(404, 'Документ не найден');
}

// Можно ли сохранить документ с таким видом и в такую папку
async function assertPlacement(req, f) {
  if (req.user.docTypes && !req.user.docTypes.includes(f.doc_type)) throw httpError(403, 'Нет доступа к документам этого вида');
  if (!(await query('SELECT 1 FROM doc_types WHERE code = $1', [f.doc_type])).rows[0]) throw httpError(400, 'Неизвестный вид документа');
  if (f.folder_id === null) {
    if (req.user.folderIds) throw httpError(400, 'Выберите папку: вам доступны только документы в выданных папках');
    return;
  }
  if (!(await query('SELECT 1 FROM folders WHERE id = $1', [f.folder_id])).rows[0]) throw httpError(400, 'Папка не найдена');
  if (req.user.folderIds && !req.user.folderIds.includes(f.folder_id)) throw httpError(403, 'Нет доступа к этой папке');
}

// Теги приходят списком названий (JSON или через запятую)
function parseTags(v) {
  if (v === undefined || v === null) return null;
  let list = v;
  if (typeof v === 'string') {
    try { list = JSON.parse(v); } catch { list = v.split(','); }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((t) => String(t).trim().slice(0, 60)).filter((t) => {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 30);
}

const TAG_COLORS = ['#0052CC', '#00875A', '#FF8B00', '#5243AA', '#DE350B', '#00A3BF', '#6554C0', '#36B37E'];

// Записать теги документа; новые названия создаются на лету
async function saveTags(client, id, names) {
  if (names === null) return;
  await client.query('DELETE FROM document_tags WHERE document_id = $1', [id]);
  for (const name of names) {
    let tag = (await client.query('SELECT id FROM tags WHERE lower(name) = lower($1)', [name])).rows[0];
    if (!tag) {
      const n = (await client.query('SELECT count(*)::int AS n FROM tags')).rows[0].n;
      tag = (await client.query('INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id',
        [name, TAG_COLORS[n % TAG_COLORS.length]])).rows[0];
    }
    await client.query('INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, tag.id]);
  }
}

const TAGS_JSON = (alias) => `COALESCE((SELECT json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) ORDER BY tg.name)
      FROM document_tags dt JOIN tags tg ON tg.id = dt.tag_id WHERE dt.document_id = ${alias}.id), '[]')`;

async function syncLinks(client, id, content) {
  const ids = [...new Set([...content.matchAll(LINK_RE)].map((m) => Number(m[1])))]
    .filter((t) => t !== id);
  await client.query('DELETE FROM document_links WHERE source_id = $1', [id]);
  if (ids.length) {
    await client.query(
      `INSERT INTO document_links (source_id, target_id)
       SELECT $1, id FROM documents WHERE id = ANY($2::int[])`,
      [id, ids]
    );
  }
}

async function saveFile(client, id, file) {
  // Сколько страниц в PDF и со скольких получен текст — чтобы показать, если часть документа — скан
  let info = { pages: null, textPages: null };
  if (file.originalname.toLowerCase().endsWith('.pdf')) {
    try { info = file.extracted || await extractFile(file); } catch { /* файл всё равно сохраняем */ }
  }
  // PDF со страницами без текста (сканы) — в очередь на распознавание
  const needOcr = file.originalname.toLowerCase().endsWith('.pdf') && (info.pages == null || info.textPages < info.pages);
  await client.query(
    `INSERT INTO document_files (document_id, filename, mime_type, size, data, pages, text_pages, ocr_status, ocr_pages, ocr_error, ocr_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL)
     ON CONFLICT (document_id) DO UPDATE SET
       filename = EXCLUDED.filename, mime_type = EXCLUDED.mime_type,
       size = EXCLUDED.size, data = EXCLUDED.data, uploaded_at = now(),
       pages = EXCLUDED.pages, text_pages = EXCLUDED.text_pages,
       ocr_status = EXCLUDED.ocr_status, ocr_pages = NULL, ocr_error = NULL, ocr_at = NULL`,
    [id, file.originalname, file.mimetype || 'application/octet-stream', file.size, file.buffer, info.pages, info.textPages,
      needOcr ? 'pending' : 'none']
  );
}

function dbError(e) {
  if (e.code === '54000') {
    return httpError(400, 'Текст документа слишком велик для индексации. Разделите его на части.');
  }
  return e;
}

/* ---------- Поиск / список ---------- */
router.get('/', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 500);
  const mode = ['all', 'title', 'content'].includes(req.query.mode) ? req.query.mode : 'all';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];

  if (req.query.type) where.push(`d.doc_type = ${p(String(req.query.type))}`);
  where.push(...visibleConds(req.user, p));
  // Папка: вместе с вложенными; folder=0 — документы без папки
  if (req.query.folder !== undefined && req.query.folder !== '') {
    const fid = Number(req.query.folder);
    if (fid === 0) where.push('d.folder_id IS NULL');
    else if (Number.isInteger(fid)) {
      where.push(`d.folder_id IN (WITH RECURSIVE t AS (SELECT id FROM folders WHERE id = ${p(fid)}
        UNION SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id) SELECT id FROM t)`);
    }
  }
  if (req.query.tag) {
    const tags = String(req.query.tag).split(',').map(Number).filter(Number.isInteger);
    // Несколько тегов — документ должен иметь все
    for (const t of tags) where.push(`EXISTS (SELECT 1 FROM document_tags x WHERE x.document_id = d.id AND x.tag_id = ${p(t)})`);
  }
  if (STATUSES.includes(req.query.status)) where.push(`d.status = ${p(req.query.status)}`);

  let rank = '0';
  let snippet = 'left(p.content, 300)';

  if (q) {
    const tq = `websearch_to_tsquery('russian', ${p(q)})`;
    const like = p(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    const titleMatch = `(d.title_tsv @@ ${tq} OR d.title ILIKE ${like} OR d.number ILIKE ${like})`;
    const titleRank = `(ts_rank(d.title_tsv, ${tq}) + CASE WHEN d.title ILIKE ${like} OR d.number ILIKE ${like} THEN 1 ELSE 0 END)`;
    const contentRank = `ts_rank_cd(d.content_tsv, ${tq}, 32)`;
    const headline = `ts_headline('russian', p.content, ${tq},
      'StartSel=⟦, StopSel=⟧, MaxFragments=3, MaxWords=30, MinWords=12, FragmentDelimiter=" … "')`;

    if (mode === 'title') {
      where.push(titleMatch);
      rank = titleRank;
    } else if (mode === 'content') {
      where.push(`d.content_tsv @@ ${tq}`);
      rank = contentRank;
      snippet = headline;
    } else {
      where.push(`(${titleMatch} OR d.content_tsv @@ ${tq})`);
      rank = `(${titleRank} * 2 + ${contentRank})`;
      snippet = headline;
    }
  }

  const sort = req.query.sort || (q ? 'relevance' : 'updated');
  const order = {
    relevance: 'rank DESC, updated_at DESC',
    updated: 'updated_at DESC',
    title: 'title ASC',
    adopted: 'adopted_at DESC NULLS LAST, id DESC',
  }[sort] || 'updated_at DESC';

  // Внутренний запрос выбирает страницу, фрагменты считаются только для неё
  const sql = `
    SELECT p.id, p.title, p.doc_type, p.number, p.adopted_at, p.status, p.updated_at, p.folder_id,
           p.rank, p.total, ${snippet} AS snippet, ${TAGS_JSON('p')} AS tags
    FROM (
      SELECT d.id, d.title, d.doc_type, d.number, d.adopted_at, d.status, d.updated_at, d.content, d.folder_id,
             ${rank} AS rank, COUNT(*) OVER () AS total
      FROM documents d
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${order}
      LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}
    ) p
    ORDER BY ${order}`;

  const { rows } = await query(sql, params);
  res.json({
    items: rows.map(({ total, ...r }) => r),
    total: rows.length ? Number(rows[0].total) : 0,
    page,
    limit,
  });
}));

/* ---------- Извлечение текста из файла (для предпросмотра в редакторе) ---------- */
router.post('/extract', requireRole(...EDITORS), upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw httpError(400, 'Файл не передан');
  const r = await extractFile(req.file);
  res.json({ text: r.text, filename: req.file.originalname, pages: r.pages, textPages: r.textPages, warning: r.warning });
}));

/* ---------- Документ ---------- */
router.get('/:id', ah(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await query(
    `SELECT d.id, d.title, d.doc_type, d.number, d.adopted_at, d.status, d.content,
            d.created_at, d.updated_at, d.folder_id, ${TAGS_JSON('d')} AS tags,
            f.pages AS file_pages, f.text_pages AS file_text_pages, f.mime_type AS file_mime,
            f.ocr_status, f.ocr_pages, f.ocr_error, f.ocr_at,
            CASE WHEN cu.is_system THEN 'Служба ИТ' ELSE COALESCE(NULLIF(cu.full_name, ''), cu.username) END AS created_by_name,
            CASE WHEN uu.is_system THEN 'Служба ИТ' ELSE COALESCE(NULLIF(uu.full_name, ''), uu.username) END AS updated_by_name,
            f.filename AS file_name, f.size AS file_size
     FROM documents d
     LEFT JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users uu ON uu.id = d.updated_by
     LEFT JOIN document_files f ON f.document_id = d.id
     WHERE d.id = $1`,
    [id]
  );
  if (!rows[0] || !canSeeDoc(req.user, rows[0])) throw httpError(404, 'Документ не найден');

  const lp = [id];
  const conds = visibleConds(req.user, (v) => { lp.push(v); return `$${lp.length}`; });
  const vis = conds.length ? 'AND ' + conds.join(' AND ') : '';
  const [links, backlinks] = await Promise.all([
    query(
      `SELECT d.id, d.title, d.doc_type, d.number, d.status FROM document_links l
       JOIN documents d ON d.id = l.target_id WHERE l.source_id = $1 ${vis} ORDER BY d.title`,
      lp
    ),
    query(
      `SELECT d.id, d.title, d.doc_type, d.number, d.status FROM document_links l
       JOIN documents d ON d.id = l.source_id WHERE l.target_id = $1 ${vis} ORDER BY d.title`,
      lp
    ),
  ]);

  res.json({ ...rows[0], ocr_progress: ocr.progress(id), ocr_available: ocr.available(), links: links.rows, backlinks: backlinks.rows });
}));

// Повторить распознавание (после ошибки или когда компоненты распознавания были не установлены)
router.post('/:id/ocr', requireRole(...EDITORS), ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rowCount } = await query(
    `UPDATE document_files SET ocr_status = 'pending', ocr_error = NULL
      WHERE document_id = $1 AND lower(filename) LIKE '%.pdf' AND COALESCE(ocr_status, '') <> 'running'`, [id]);
  if (!rowCount) throw httpError(400, 'У документа нет PDF-файла или распознавание уже идёт');
  ocr.kick();
  res.json({ ok: true });
}));

router.get('/:id/file', ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rows } = await query(
    'SELECT filename, mime_type, data FROM document_files WHERE document_id = $1',
    [id]
  );
  if (!rows[0]) throw httpError(404, 'Файл не найден');
  // ?inline=1 — открыть PDF/текст прямо в браузере (весь документ целиком, включая сканы)
  const isPdf = rows[0].filename.toLowerCase().endsWith('.pdf');
  const isText = /\.(txt|md)$/i.test(rows[0].filename);
  const inline = req.query.inline === '1' && (isPdf || isText);
  res.set('Content-Type', isPdf ? 'application/pdf' : isText && inline ? 'text/plain; charset=utf-8' : rows[0].mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  // Встроенный просмотрщик PDF в некоторых браузерах не работает при строгой политике содержимого
  if (inline && isPdf) res.removeHeader('Content-Security-Policy');
  res.set(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`
  );
  res.send(rows[0].data);
}));

router.get('/:id/versions', ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rows } = await query(
    `SELECT v.id, v.title, v.edited_at, length(v.content) AS content_length,
            CASE WHEN u.is_system THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS edited_by_name
     FROM document_versions v LEFT JOIN users u ON u.id = v.edited_by
     WHERE v.document_id = $1 ORDER BY v.edited_at DESC, v.id DESC`,
    [id]
  );
  res.json({ items: rows });
}));

router.get('/:id/versions/:vid', ah(async (req, res) => {
  const id = parseId(req.params.id);
  const vid = parseId(req.params.vid);
  await assertVisible(req, id);
  const { rows } = await query(
    `SELECT v.*, CASE WHEN u.is_system THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS edited_by_name
     FROM document_versions v LEFT JOIN users u ON u.id = v.edited_by
     WHERE v.document_id = $1 AND v.id = $2`,
    [id, vid]
  );
  if (!rows[0]) throw httpError(404, 'Версия не найдена');
  res.json(rows[0]);
}));

/* ---------- Создание ---------- */
router.post('/', requireRole(...EDITORS), upload.single('file'), ah(async (req, res) => {
  const f = parseDocFields(req.body);
  await assertPlacement(req, f);
  if (req.file && req.file.originalname.toLowerCase().endsWith('.pdf')) req.file.extracted = await extractFile(req.file);
  if (req.file && !f.content.trim()) f.content = (req.file.extracted || await extractFile(req.file)).text;

  try {
    const id = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO documents (title, doc_type, number, adopted_at, status, content, folder_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
        [f.title, f.doc_type, f.number, f.adopted_at, f.status, f.content, f.folder_id, req.user.id]
      );
      const newId = rows[0].id;
      await saveTags(c, newId, f.tags || []);
      if (req.file) await saveFile(c, newId, req.file);
      await syncLinks(c, newId, f.content);
      return newId;
    });
    if (req.file) ocr.kick();
    res.status(201).json({ id });
  } catch (e) {
    throw dbError(e);
  }
}));

/* ---------- Редактирование ---------- */
router.put('/:id', requireRole(...EDITORS), upload.single('file'), ah(async (req, res) => {
  const id = parseId(req.params.id);
  const f = parseDocFields(req.body);
  await assertVisible(req, id);
  await assertPlacement(req, f);
  if (req.file && req.file.originalname.toLowerCase().endsWith('.pdf')) req.file.extracted = await extractFile(req.file);
  if (req.file && !f.content.trim()) f.content = (req.file.extracted || await extractFile(req.file)).text;

  try {
    await withTx(async (c) => {
      const { rows } = await c.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      const old = rows[0];
      if (!old) throw httpError(404, 'Документ не найден');

      // Защита от одновременного редактирования
      const expected = req.body.expected_updated_at;
      if (expected && new Date(expected).getTime() !== old.updated_at.getTime()) {
        throw httpError(409, 'Документ был изменён другим пользователем. Обновите страницу и повторите правку.');
      }

      await c.query(
        `INSERT INTO document_versions
           (document_id, title, doc_type, number, adopted_at, status, content, edited_by, edited_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, old.title, old.doc_type, old.number, old.adopted_at, old.status, old.content,
         old.updated_by, old.updated_at]
      );
      await c.query(
        `UPDATE documents SET title = $1, doc_type = $2, number = $3, adopted_at = $4,
           status = $5, content = $6, updated_by = $7, updated_at = now(), folder_id = $9
         WHERE id = $8`,
        [f.title, f.doc_type, f.number, f.adopted_at, f.status, f.content, req.user.id, id, f.folder_id]
      );
      await saveTags(c, id, f.tags);
      if (req.file) await saveFile(c, id, req.file);
      else if (req.body.remove_file === '1') {
        await c.query('DELETE FROM document_files WHERE document_id = $1', [id]);
      }
      await syncLinks(c, id, f.content);
    });
    if (req.file) ocr.kick();
    res.json({ id });
  } catch (e) {
    throw dbError(e);
  }
}));

/* ---------- Удаление ---------- */
router.delete('/:id', requireRole(...EDITORS), ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rowCount } = await query('DELETE FROM documents WHERE id = $1', [id]);
  if (!rowCount) throw httpError(404, 'Документ не найден');
  res.json({ ok: true });
}));

module.exports = router;
