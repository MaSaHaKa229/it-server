// Справочник видов документов: читают все, изменяют редакторы
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ah, httpError, EDITORS } = require('../utils');

const router = express.Router();
router.use(requireAuth);

const HEX = /^#[0-9a-fA-F]{6}$/;

// Список видов (с учётом ограничений пользователя) и число документов каждого вида
router.get('/', ah(async (req, res) => {
  const t = req.user.docTypes;
  // Количество — только по папкам, доступным пользователю
  const { rows } = await query(
    `SELECT dt.code, dt.name, dt.color, dt.sort,
            (SELECT count(*)::int FROM documents d WHERE d.doc_type = dt.code
               AND ($2::int[] IS NULL OR d.folder_id = ANY($2::int[]))) AS count
       FROM doc_types dt
      WHERE $1::text[] IS NULL OR dt.code = ANY($1::text[])
      ORDER BY dt.sort, dt.name`, [t, req.user.folderIds]);
  res.json({ items: rows });
}));

function body(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw httpError(400, 'Укажите название вида');
  const color = HEX.test(b.color || '') ? b.color : '#6B778C';
  const sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0;
  return { name, color, sort };
}
const dup = (e) => (e.code === '23505' ? httpError(409, 'Вид с таким названием уже есть') : e);

router.post('/', requireRole(...EDITORS), ah(async (req, res) => {
  const f = body(req.body || {});
  const code = 't_' + crypto.randomBytes(4).toString('hex');
  try {
    const { rows } = await query(
      'INSERT INTO doc_types (code, name, color, sort) VALUES ($1, $2, $3, $4) RETURNING code, name, color, sort',
      [code, f.name, f.color, f.sort]);
    res.status(201).json(rows[0]);
  } catch (e) { throw dup(e); }
}));

router.put('/:code', requireRole(...EDITORS), ah(async (req, res) => {
  const f = body(req.body || {});
  try {
    const { rows } = await query(
      'UPDATE doc_types SET name = $2, color = $3, sort = $4 WHERE code = $1 RETURNING code, name, color, sort',
      [req.params.code, f.name, f.color, f.sort]);
    if (!rows[0]) throw httpError(404, 'Вид не найден');
    res.json(rows[0]);
  } catch (e) { throw dup(e); }
}));

router.delete('/:code', requireRole(...EDITORS), ah(async (req, res) => {
  const used = (await query('SELECT count(*)::int AS n FROM documents WHERE doc_type = $1', [req.params.code])).rows[0].n;
  if (used) throw httpError(400, `Этот вид указан у ${used} документ(ов). Сначала смените им вид`);
  const { rowCount } = await query('DELETE FROM doc_types WHERE code = $1', [req.params.code]);
  if (!rowCount) throw httpError(404, 'Вид не найден');
  res.json({ ok: true });
}));

module.exports = router;
