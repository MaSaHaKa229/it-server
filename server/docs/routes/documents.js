const express = require('express');
const multer = require('multer');
const { query, withTx } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { extractText, fixFilename, ALLOWED_EXT } = require('../extract');
const { ah, httpError, parseId, TYPES, STATUSES, EDITORS } = require('../utils');

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
    doc_type: TYPES.includes(body.doc_type) ? body.doc_type : 'other',
    number: String(body.number || '').trim().slice(0, 100),
    adopted_at,
    status: STATUSES.includes(body.status) ? body.status : 'active',
    content: String(body.content ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n'),
  };
}

/* ---------- Ограничение по видам документов (задаётся администратором портала) ---------- */
const typeAllowed = (req, t) => !req.user.docTypes || req.user.docTypes.includes(t);

async function assertVisible(req, id) {
  if (!req.user.docTypes) return;
  const { rows } = await query('SELECT doc_type FROM documents WHERE id = $1', [id]);
  if (!rows[0] || !typeAllowed(req, rows[0].doc_type)) throw httpError(404, 'Документ не найден');
}

function assertTypeAllowed(req, t) {
  if (!typeAllowed(req, t)) throw httpError(403, 'Нет доступа к документам этого вида');
}

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
  await client.query(
    `INSERT INTO document_files (document_id, filename, mime_type, size, data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (document_id) DO UPDATE SET
       filename = EXCLUDED.filename, mime_type = EXCLUDED.mime_type,
       size = EXCLUDED.size, data = EXCLUDED.data, uploaded_at = now()`,
    [id, file.originalname, file.mimetype || 'application/octet-stream', file.size, file.buffer]
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

  if (TYPES.includes(req.query.type)) where.push(`d.doc_type = ${p(req.query.type)}`);
  if (req.user.docTypes) where.push(`d.doc_type = ANY(${p(req.user.docTypes)}::text[])`);
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
    SELECT p.id, p.title, p.doc_type, p.number, p.adopted_at, p.status, p.updated_at,
           p.rank, p.total, ${snippet} AS snippet
    FROM (
      SELECT d.id, d.title, d.doc_type, d.number, d.adopted_at, d.status, d.updated_at, d.content,
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
  res.json({ text: await extractText(req.file), filename: req.file.originalname });
}));

/* ---------- Документ ---------- */
router.get('/:id', ah(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await query(
    `SELECT d.id, d.title, d.doc_type, d.number, d.adopted_at, d.status, d.content,
            d.created_at, d.updated_at,
            COALESCE(NULLIF(cu.full_name, ''), cu.username) AS created_by_name,
            COALESCE(NULLIF(uu.full_name, ''), uu.username) AS updated_by_name,
            f.filename AS file_name, f.size AS file_size
     FROM documents d
     LEFT JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users uu ON uu.id = d.updated_by
     LEFT JOIN document_files f ON f.document_id = d.id
     WHERE d.id = $1`,
    [id]
  );
  if (!rows[0] || !typeAllowed(req, rows[0].doc_type)) throw httpError(404, 'Документ не найден');

  const vis = req.user.docTypes ? 'AND d.doc_type = ANY($2::text[])' : '';
  const lp = req.user.docTypes ? [id, req.user.docTypes] : [id];
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

  res.json({ ...rows[0], links: links.rows, backlinks: backlinks.rows });
}));

router.get('/:id/file', ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rows } = await query(
    'SELECT filename, mime_type, data FROM document_files WHERE document_id = $1',
    [id]
  );
  if (!rows[0]) throw httpError(404, 'Файл не найден');
  res.set('Content-Type', rows[0].mime_type);
  res.set(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`
  );
  res.send(rows[0].data);
}));

router.get('/:id/versions', ah(async (req, res) => {
  const id = parseId(req.params.id);
  await assertVisible(req, id);
  const { rows } = await query(
    `SELECT v.id, v.title, v.edited_at, length(v.content) AS content_length,
            COALESCE(NULLIF(u.full_name, ''), u.username) AS edited_by_name
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
    `SELECT v.*, COALESCE(NULLIF(u.full_name, ''), u.username) AS edited_by_name
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
  assertTypeAllowed(req, f.doc_type);
  if (req.file && !f.content.trim()) f.content = await extractText(req.file);

  try {
    const id = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO documents (title, doc_type, number, adopted_at, status, content, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [f.title, f.doc_type, f.number, f.adopted_at, f.status, f.content, req.user.id]
      );
      const newId = rows[0].id;
      if (req.file) await saveFile(c, newId, req.file);
      await syncLinks(c, newId, f.content);
      return newId;
    });
    res.status(201).json({ id });
  } catch (e) {
    throw dbError(e);
  }
}));

/* ---------- Редактирование ---------- */
router.put('/:id', requireRole(...EDITORS), upload.single('file'), ah(async (req, res) => {
  const id = parseId(req.params.id);
  const f = parseDocFields(req.body);
  assertTypeAllowed(req, f.doc_type);
  await assertVisible(req, id);
  if (req.file && !f.content.trim()) f.content = await extractText(req.file);

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
           status = $5, content = $6, updated_by = $7, updated_at = now()
         WHERE id = $8`,
        [f.title, f.doc_type, f.number, f.adopted_at, f.status, f.content, req.user.id, id]
      );
      if (req.file) await saveFile(c, id, req.file);
      else if (req.body.remove_file === '1') {
        await c.query('DELETE FROM document_files WHERE document_id = $1', [id]);
      }
      await syncLinks(c, id, f.content);
    });
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
