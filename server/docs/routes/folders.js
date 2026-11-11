// Папки (дерево) и теги реестра документов
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { visibleConds } = require('../access');
const { ah, httpError, parseId, EDITORS } = require('../utils');

const router = express.Router();
router.use(requireAuth);

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Все папки с путём («Отдел / Приказы») в порядке дерева */
async function loadTree() {
  const { rows } = await query(
    `WITH RECURSIVE t AS (
       SELECT id, parent_id, name, sort, name::text AS path, 0 AS depth,
              ARRAY[lpad(sort::text, 6, '0') || lower(name)] AS ord
         FROM folders WHERE parent_id IS NULL
       UNION ALL
       SELECT f.id, f.parent_id, f.name, f.sort, t.path || ' / ' || f.name, t.depth + 1,
              t.ord || (lpad(f.sort::text, 6, '0') || lower(f.name))
         FROM folders f JOIN t ON f.parent_id = t.id)
     SELECT id, parent_id, name, sort, path, depth FROM t ORDER BY ord`);
  return rows;
}

// Дерево папок, видимых пользователю, с количеством документов (в самой папке и с вложенными)
router.get('/', ah(async (req, res) => {
  const tree = await loadTree();
  const params = [];
  const conds = visibleConds(req.user, (v) => { params.push(v); return `$${params.length}`; });
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const counts = (await query(`SELECT d.folder_id, count(*)::int AS n FROM documents d ${where} GROUP BY d.folder_id`, params)).rows;
  const own = new Map(counts.map((r) => [r.folder_id, r.n]));
  const allowed = req.user.folderIds ? new Set(req.user.folderIds) : null;
  const byId = new Map(tree.map((f) => [f.id, { ...f, count: own.get(f.id) || 0, total: own.get(f.id) || 0, allowed: !allowed || allowed.has(f.id) }]));
  // Сумма с вложенными: идём с конца (дети после родителей)
  for (const f of [...byId.values()].reverse()) {
    if (f.parent_id && byId.has(f.parent_id)) byId.get(f.parent_id).total += f.total;
  }
  // Ограниченному пользователю показываем только выданные папки (и вложенные в них)
  const items = [...byId.values()].filter((f) => f.allowed);
  // Глубина для отрисовки: относительно ближайшей видимой родительской папки
  const visible = new Set(items.map((f) => f.id));
  for (const f of items) {
    let depth = 0;
    let cur = byId.get(f.parent_id);
    while (cur) { if (visible.has(cur.id)) depth++; cur = byId.get(cur.parent_id); }
    f.level = depth;
  }
  res.json({
    items: items.map(({ allowed: _a, ...f }) => f),
    // «Без папки» доступно только без ограничения по папкам
    unfiled: allowed ? null : (own.get(null) || 0),
    restricted: !!allowed,
  });
}));

async function folderBody(req, id) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) throw httpError(400, 'Укажите название папки');
  const parentId = b.parent_id ? Number(b.parent_id) : null;
  const sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0;
  const allowed = req.user.folderIds;
  if (parentId === null) {
    if (allowed) throw httpError(403, 'Создавать папки верхнего уровня может сотрудник с доступом ко всем папкам');
  } else {
    if (!(await query('SELECT 1 FROM folders WHERE id = $1', [parentId])).rows[0]) throw httpError(400, 'Родительская папка не найдена');
    if (allowed && !allowed.includes(parentId)) throw httpError(403, 'Нет доступа к родительской папке');
    if (id) {
      // Нельзя переместить папку в саму себя или в свою вложенную
      const { rows } = await query(
        `WITH RECURSIVE t AS (SELECT id FROM folders WHERE id = $1
           UNION SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id) SELECT 1 FROM t WHERE id = $2`, [id, parentId]);
      if (rows[0]) throw httpError(400, 'Нельзя переместить папку внутрь самой себя');
    }
  }
  return { name, parentId, sort };
}
const dup = (e) => (e.code === '23505' ? httpError(409, 'Папка с таким названием здесь уже есть') : e);

router.post('/', requireRole(...EDITORS), ah(async (req, res) => {
  const f = await folderBody(req, null);
  try {
    const { rows } = await query('INSERT INTO folders (name, parent_id, sort) VALUES ($1, $2, $3) RETURNING id', [f.name, f.parentId, f.sort]);
    res.status(201).json(rows[0]);
  } catch (e) { throw dup(e); }
}));

router.put('/:id', requireRole(...EDITORS), ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (req.user.folderIds && !req.user.folderIds.includes(id)) throw httpError(403, 'Нет доступа к этой папке');
  const f = await folderBody(req, id);
  try {
    const { rowCount } = await query('UPDATE folders SET name = $1, parent_id = $2, sort = $3 WHERE id = $4', [f.name, f.parentId, f.sort, id]);
    if (!rowCount) throw httpError(404, 'Папка не найдена');
    res.json({ ok: true });
  } catch (e) { throw dup(e); }
}));

router.delete('/:id', requireRole(...EDITORS), ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (req.user.folderIds && !req.user.folderIds.includes(id)) throw httpError(403, 'Нет доступа к этой папке');
  const sub = (await query('SELECT count(*)::int AS n FROM folders WHERE parent_id = $1', [id])).rows[0].n;
  if (sub) throw httpError(400, 'В папке есть вложенные папки. Сначала удалите или переместите их');
  const docs = (await query('SELECT count(*)::int AS n FROM documents WHERE folder_id = $1', [id])).rows[0].n;
  if (docs) throw httpError(400, `В папке ${docs} документ(ов). Сначала переместите их в другую папку`);
  const { rowCount } = await query('DELETE FROM folders WHERE id = $1', [id]);
  if (!rowCount) throw httpError(404, 'Папка не найдена');
  res.json({ ok: true });
}));

// ---------------- Теги ----------------
const tags = express.Router();
tags.use(requireAuth);

tags.get('/', ah(async (req, res) => {
  const params = [];
  const conds = visibleConds(req.user, (v) => { params.push(v); return `$${params.length}`; });
  const vis = conds.length ? 'AND ' + conds.join(' AND ') : '';
  const { rows } = await query(
    `SELECT t.id, t.name, t.color,
            (SELECT count(*)::int FROM document_tags dt JOIN documents d ON d.id = dt.document_id
              WHERE dt.tag_id = t.id ${vis}) AS count
       FROM tags t ORDER BY lower(t.name)`, params);
  res.json({ items: rows });
}));

function tagBody(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Укажите название тега');
  return [name, HEX.test(b.color || '') ? b.color : '#6B778C'];
}
const dupTag = (e) => (e.code === '23505' ? httpError(409, 'Такой тег уже есть') : e);

tags.post('/', requireRole(...EDITORS), ah(async (req, res) => {
  try {
    const { rows } = await query('INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color', tagBody(req.body || {}));
    res.status(201).json(rows[0]);
  } catch (e) { throw dupTag(e); }
}));
tags.put('/:id', requireRole(...EDITORS), ah(async (req, res) => {
  try {
    const { rows } = await query('UPDATE tags SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color',
      [...tagBody(req.body || {}), parseId(req.params.id)]);
    if (!rows[0]) throw httpError(404, 'Тег не найден');
    res.json(rows[0]);
  } catch (e) { throw dupTag(e); }
}));
// Удаление тега снимает его со всех документов (сами документы не меняются)
tags.delete('/:id', requireRole(...EDITORS), ah(async (req, res) => {
  if (req.user.folderIds || req.user.docTypes) throw httpError(403, 'Удалять теги может сотрудник с доступом ко всем документам');
  const { rowCount } = await query('DELETE FROM tags WHERE id = $1', [parseId(req.params.id)]);
  if (!rowCount) throw httpError(404, 'Тег не найден');
  res.json({ ok: true });
}));

module.exports = { folders: router, tags, loadTree };
