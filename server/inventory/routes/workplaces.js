// Рабочие места: к рабочему месту привязывается любая техника в любом количестве.
// Читатель видит рабочие места и только ту технику на них, которая ему разрешена.
const express = require('express');
const { query, tx } = require('../db');
const { requireStaff } = require('../access');
const { buildDeviceQuery, sanitizeRow, loadGlobalDefs } = require('../deviceQuery');
const { HttpError, ah, str, intOrNull } = require('../util');

const router = express.Router();

// Условие «техника видна пользователю» для подсчётов
function visibleWhere(P, params) {
  const w = [];
  if (P.types !== null) { params.push(P.types); w.push(`d.type_id = ANY($${params.length}::int[])`); }
  if (P.departments !== null) { params.push(P.departments); w.push(`d.department_id = ANY($${params.length}::int[])`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

const SELECT = (vis) => `
  SELECT w.id, w.name, w.notes, w.created_at, w.updated_at,
         w.employee_id, e.value AS employee,
         w.department_id, dp.value AS department,
         w.location_id, l.value AS location,
         (SELECT count(*)::int FROM devices d WHERE d.workplace_id = w.id${vis}) AS device_count,
         (SELECT string_agg(x.name || CASE WHEN x.n > 1 THEN ' ×' || x.n ELSE '' END, ', ' ORDER BY x.sort, x.name)
            FROM (SELECT t.name, t.sort, count(*) AS n FROM devices d JOIN device_types t ON t.id = d.type_id
                   WHERE d.workplace_id = w.id${vis} GROUP BY t.name, t.sort) x) AS device_types
    FROM workplaces w
    LEFT JOIN lookups e ON e.id = w.employee_id
    LEFT JOIN lookups dp ON dp.id = w.department_id
    LEFT JOIN lookups l ON l.id = w.location_id`;

router.get('/', ah(async (req, res) => {
  const params = [];
  const vis = visibleWhere(req.perms, params);
  const { rows } = await query(`${SELECT(vis)} ORDER BY w.name`, params);
  res.json(rows);
}));

router.get('/export.xlsx', ah(async (req, res) => {
  const params = [];
  const vis = visibleWhere(req.perms, params);
  const { rows } = await query(`${SELECT(vis)} ORDER BY w.name`, params);
  await require('../../portal/xlsx').sendXlsx(res, 'workplaces.xlsx', 'Рабочие места', [
    { header: 'Рабочее место', key: 'name', width: 28 }, { header: 'Сотрудник', key: 'employee', width: 26 },
    { header: 'Отдел', key: 'department', width: 24 }, { header: 'Расположение', key: 'location', width: 18 },
    { header: 'Техники', key: 'device_count', width: 10 }, { header: 'Что стоит', key: 'device_types', width: 40 },
    { header: 'Примечание', key: 'notes', width: 40 },
  ], rows);
}));

async function loadWorkplace(req, id) {
  const params = [];
  const vis = visibleWhere(req.perms, params);
  params.push(id);
  const { rows } = await query(`${SELECT(vis)} WHERE w.id = $${params.length}`, params);
  if (!rows[0]) throw new HttpError(404, 'Рабочее место не найдено');
  return rows[0];
}

async function workplaceDevices(req, id) {
  const defs = await loadGlobalDefs({ query });
  const b = buildDeviceQuery({ P: req.perms, defs, workplaceId: id, sort: 'type', dir: 'asc' });
  const { rows } = await query(b.sql, b.params);
  return rows.map((r) => sanitizeRow(r, req.perms, b.vis));
}

router.get('/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const w = await loadWorkplace(req, id);
  res.json({ ...w, devices: await workplaceDevices(req, id) });
}));

// Техника для привязки: поиск по всей базе (с учётом прав), с указанием текущего рабочего места
router.get('/:id/candidates', requireStaff, ah(async (req, res) => {
  const defs = await loadGlobalDefs({ query });
  const b = buildDeviceQuery({ P: req.perms, defs, q: req.query.q, sort: 'key', dir: 'asc', limit: 50 });
  const { rows } = await query(b.sql, b.params);
  res.json(rows.map((r) => sanitizeRow(r, req.perms, b.vis)));
}));

async function body(b) {
  const name = str(b.name, 200);
  if (!name) throw new HttpError(400, 'Укажите название рабочего места');
  return [name, intOrNull(b.employee_id), intOrNull(b.department_id), intOrNull(b.location_id), str(b.notes, 5000)];
}
const dup = (e) => (e.code === '23505' ? new HttpError(409, 'Рабочее место с таким названием уже есть') : e);

router.post('/', requireStaff, ah(async (req, res) => {
  try {
    const { rows } = await query(
      `INSERT INTO workplaces (name, employee_id, department_id, location_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [...(await body(req.body || {})), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { throw dup(e); }
}));

router.put('/:id', requireStaff, ah(async (req, res) => {
  try {
    const { rowCount } = await query(
      `UPDATE workplaces SET name = $1, employee_id = $2, department_id = $3, location_id = $4, notes = $5,
              updated_at = now() WHERE id = $6`, [...(await body(req.body || {})), intOrNull(req.params.id)]);
    if (!rowCount) throw new HttpError(404, 'Рабочее место не найдено');
    res.json({ ok: true });
  } catch (e) { throw dup(e); }
}));

// Запись в историю каждой единицы техники
async function logMove(db, userId, deviceId, from, to) {
  await db.query(
    `INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'updated', $3)`,
    [deviceId, userId, JSON.stringify({ 'Рабочее место': [from || null, to || null] })]);
}

// Привязать технику (ids — любое количество). Техника с другого рабочего места переносится.
router.post('/:id/devices', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
  if (!ids.length) throw new HttpError(400, 'Выберите технику');
  const moved = await tx(async (db) => {
    const wp = (await db.query('SELECT name FROM workplaces WHERE id = $1', [id])).rows[0];
    if (!wp) throw new HttpError(404, 'Рабочее место не найдено');
    const { rows } = await db.query(
      `SELECT d.id, w.name AS old_name FROM devices d LEFT JOIN workplaces w ON w.id = d.workplace_id
        WHERE d.id = ANY($1::int[]) AND d.workplace_id IS DISTINCT FROM $2 FOR UPDATE OF d`, [ids, id]);
    for (const r of rows) await logMove(db, req.user.id, r.id, r.old_name, wp.name);
    await db.query('UPDATE devices SET workplace_id = $2, updated_at = now(), updated_by = $3 WHERE id = ANY($1::int[])',
      [rows.map((r) => r.id), id, req.user.id]);
    await db.query('UPDATE workplaces SET updated_at = now() WHERE id = $1', [id]);
    return rows.length;
  });
  res.json({ ok: true, attached: moved });
}));

// Отвязать технику от рабочего места
router.delete('/:id/devices/:deviceId', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const deviceId = intOrNull(req.params.deviceId);
  await tx(async (db) => {
    const wp = (await db.query('SELECT name FROM workplaces WHERE id = $1', [id])).rows[0];
    const { rowCount } = await db.query(
      'UPDATE devices SET workplace_id = NULL, updated_at = now(), updated_by = $3 WHERE id = $1 AND workplace_id = $2',
      [deviceId, id, req.user.id]);
    if (!rowCount) throw new HttpError(404, 'Эта техника не привязана к рабочему месту');
    await logMove(db, req.user.id, deviceId, wp && wp.name, null);
  });
  res.json({ ok: true });
}));

// Удаление рабочего места: техника остаётся в базе, привязка снимается
router.delete('/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await tx(async (db) => {
    const wp = (await db.query('SELECT name FROM workplaces WHERE id = $1', [id])).rows[0];
    if (!wp) throw new HttpError(404, 'Рабочее место не найдено');
    const { rows } = await db.query('SELECT id FROM devices WHERE workplace_id = $1', [id]);
    for (const r of rows) await logMove(db, req.user.id, r.id, wp.name, null);
    await db.query('DELETE FROM workplaces WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

module.exports = router;
