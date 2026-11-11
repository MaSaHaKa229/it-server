// Справочники, типы техники, доп. поля, ПО, сохранённые фильтры, метаданные
const express = require('express');
const crypto = require('crypto');
const { query, tx } = require('../db');
const {
  CORE_FIELDS, EXTRA_PERMISSION_FIELDS, requireStaff, canSeeField, isStaff,
} = require('../access');
const { loadGlobalDefs, extraVisibility, LOOKUP_FIELDS } = require('../deviceQuery');
const { HttpError, ah, str, intOrNull } = require('../util');
const { loadStatuses } = require('../statuses');
const { compactExtra, loadSoftwareDefs } = require('../extra');

const router = express.Router();
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'bool', 'select', 'lookup'];
const CORE_KEYS = CORE_FIELDS.map((f) => f.key);
const lookupUsageExpr = `(SELECT count(*) FROM devices d WHERE l.id IN (${LOOKUP_FIELDS.map((f) => 'd.' + f.col).join(', ')}))::int`;

const pgUnique = (e, msg) => {
  if (e.code === '23505') throw new HttpError(409, msg);
  throw e;
};

// ======================= META =======================
router.get('/meta', ah(async (req, res) => {
  const P = req.perms;
  const typesSql = P.types === null
    ? { text: 'SELECT * FROM device_types ORDER BY sort, id', values: [] }
    : { text: 'SELECT * FROM device_types WHERE id = ANY($1::int[]) ORDER BY sort, id', values: [P.types] };
  const [types, kinds, defs, statuses, swDefs] = await Promise.all([
    query(typesSql.text, typesSql.values),
    query('SELECT code, name, is_system FROM lookup_kinds ORDER BY sort, name'),
    loadGlobalDefs({ query }),
    loadStatuses({ query }),
    P.software ? loadSoftwareDefs({ query }) : [],
  ]);
  const vis = extraVisibility(P, defs);
  res.json({
    coreFields: CORE_FIELDS.filter((f) => canSeeField(P, f.key)),
    statuses,
    softwareFieldDefs: swDefs,
    types: types.rows,
    lookupKinds: kinds.rows,
    fieldDefs: defs.filter((d) => vis.visibleIds.has(String(d.id))),
    fieldTypes: FIELD_TYPES,
    // Для настройки прав читателей (только суперадмину)
    permissionFields: req.user.role === 'superadmin'
      ? [
          ...CORE_FIELDS.map((f) => ({ key: f.key, label: f.label })),
          ...defs.map((d) => ({ key: 'f_' + d.id, label: d.label + ' (доп.)' })),
          ...EXTRA_PERMISSION_FIELDS,
        ]
      : undefined,
  });
}));

// ======================= СПРАВОЧНИКИ =======================
const kindToField = Object.fromEntries(LOOKUP_FIELDS.map((f) => [f.lookup, f.key]));

router.get('/lookups', ah(async (req, res) => {
  const P = req.perms;
  const kind = String(req.query.kind || '');
  if (kindToField[kind] && !canSeeField(P, kindToField[kind])) return res.json([]);
  const params = [kind];
  let where = 'l.kind = $1';
  const q = (req.query.q || '').trim();
  // Поиск по значению, полному и короткому названию
  if (q) {
    params.push('%' + q + '%');
    const n = params.length;
    where += ` AND (l.value ILIKE $${n} OR l.full_name ILIKE $${n} OR l.short_name ILIKE $${n})`;
  }
  if (kind === 'department' && P.departments !== null) {
    params.push(P.departments); where += ` AND l.id = ANY($${params.length}::int[])`;
  }
  const withUsage = isStaff(req.user) && req.query.usage === '1';
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const { rows } = await query(
    `SELECT l.id, l.value, l.note, l.full_name, l.short_name${withUsage ? `, ${lookupUsageExpr} AS usage` : ''}
       FROM lookups l WHERE ${where} ORDER BY l.value LIMIT ${limit}`, params);
  res.json(rows);
}));

router.post('/lookups', requireStaff, ah(async (req, res) => {
  const kind = String(req.body.kind || '');
  const value = str(req.body.value, 300);
  if (!value) throw new HttpError(400, 'Введите значение');
  const k = await query('SELECT 1 FROM lookup_kinds WHERE code = $1', [kind]);
  if (!k.rows[0]) throw new HttpError(400, 'Неизвестный справочник');
  const { rows } = await query(
    `INSERT INTO lookups (kind, value, note, full_name, short_name) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, value) DO UPDATE SET value = EXCLUDED.value,
       full_name = COALESCE(EXCLUDED.full_name, lookups.full_name), short_name = COALESCE(EXCLUDED.short_name, lookups.short_name)
     RETURNING id, value, note, full_name, short_name`,
    [kind, value, str(req.body.note, 1000), str(req.body.full_name, 500) || null, str(req.body.short_name, 100) || null]);
  res.status(201).json(rows[0]);
}));

router.put('/lookups/:id', requireStaff, ah(async (req, res) => {
  const value = str(req.body.value, 300);
  if (!value) throw new HttpError(400, 'Введите значение');
  try {
    // Полное и короткое название меняются, только если присланы
    const { rowCount } = await query(
      `UPDATE lookups SET value = $1, note = $2,
              full_name = CASE WHEN $4 THEN $5 ELSE full_name END, short_name = CASE WHEN $6 THEN $7 ELSE short_name END
        WHERE id = $3`,
      [value, str(req.body.note, 1000), intOrNull(req.params.id),
        'full_name' in req.body, str(req.body.full_name, 500) || null, 'short_name' in req.body, str(req.body.short_name, 100) || null]);
    if (!rowCount) throw new HttpError(404, 'Значение не найдено');
  } catch (e) { pgUnique(e, 'Такое значение уже есть — используйте «Объединить»'); }
  // Новое название отдела — и у заявителей сайта заявок
  await query('UPDATE helpdesk.requesters SET department = $1 WHERE department_id = $2', [value, intOrNull(req.params.id)]);
  res.json({ ok: true });
}));

// Объединить дубликаты: все ссылки на :id переводятся на into, :id удаляется
router.post('/lookups/:id/merge', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id), into = intOrNull(req.body.into);
  if (!into || id === into) throw new HttpError(400, 'Выберите значение для объединения');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, kind FROM lookups WHERE id = ANY($1::int[])', [[id, into]]);
    if (rows.length !== 2 || rows[0].kind !== rows[1].kind) throw new HttpError(400, 'Значения из разных справочников');
    for (const f of LOOKUP_FIELDS) {
      await db.query(`UPDATE devices SET ${f.col} = $1 WHERE ${f.col} = $2`, [into, id]);
    }
    await db.query(
      `UPDATE helpdesk.requesters SET department_id = $1, department = (SELECT value FROM lookups WHERE id = $1) WHERE department_id = $2`,
      [into, id]);
    await db.query('DELETE FROM lookups WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

router.delete('/lookups/:id', requireStaff, ah(async (req, res) => {
  const { rowCount } = await query('DELETE FROM lookups WHERE id = $1', [intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Значение не найдено');
  res.json({ ok: true });
}));

// Виды справочников (можно добавлять свои — например «Поставщики» для доп. полей)
router.post('/lookup-kinds', requireStaff, ah(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Введите название справочника');
  const code = 'k_' + crypto.randomBytes(4).toString('hex');
  await query('INSERT INTO lookup_kinds (code, name, sort) VALUES ($1, $2, 100)', [code, name]);
  res.status(201).json({ code, name });
}));

router.put('/lookup-kinds/:code', requireStaff, ah(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Введите название справочника');
  await query('UPDATE lookup_kinds SET name = $1 WHERE code = $2', [name, req.params.code]);
  res.json({ ok: true });
}));

router.delete('/lookup-kinds/:code', requireStaff, ah(async (req, res) => {
  const { rows } = await query('SELECT is_system FROM lookup_kinds WHERE code = $1', [req.params.code]);
  if (!rows[0]) throw new HttpError(404, 'Справочник не найден');
  if (rows[0].is_system) throw new HttpError(400, 'Системный справочник удалить нельзя');
  await query('DELETE FROM lookup_kinds WHERE code = $1', [req.params.code]);
  res.json({ ok: true });
}));

// ======================= ПО =======================
router.get('/software', ah(async (req, res) => {
  if (!req.perms.software) return res.json([]);
  const q = (req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { params.push('%' + q + '%'); where = 'WHERE s.name ILIKE $1 OR s.vendor ILIKE $1'; }
  const { rows } = await query(
    `SELECT s.id, s.name, s.vendor, s.extra,
            (SELECT count(DISTINCT device_id) FROM device_software ds WHERE ds.software_id = s.id)::int AS usage
       FROM software s ${where} ORDER BY s.name LIMIT 2000`, params);
  res.json(rows);
}));

router.post('/software', requireStaff, ah(async (req, res) => {
  const name = str(req.body.name, 300);
  if (!name) throw new HttpError(400, 'Введите название программы');
  try {
    const extra = compactExtra(req.body.extra, await loadSoftwareDefs({ query }, 'software'));
    const { rows } = await query('INSERT INTO software (name, vendor, extra) VALUES ($1, $2, $3) RETURNING id, name, vendor, extra',
      [name, str(req.body.vendor, 300), JSON.stringify(extra)]);
    res.status(201).json(rows[0]);
  } catch (e) { pgUnique(e, 'Такая программа уже есть в справочнике'); }
}));

router.put('/software/:id', requireStaff, ah(async (req, res) => {
  const name = str(req.body.name, 300);
  if (!name) throw new HttpError(400, 'Введите название программы');
  try {
    const extra = req.body.extra === undefined ? null
      : JSON.stringify(compactExtra(req.body.extra, await loadSoftwareDefs({ query }, 'software')));
    await query('UPDATE software SET name = $1, vendor = $2, extra = COALESCE($4::jsonb, extra) WHERE id = $3',
      [name, str(req.body.vendor, 300), intOrNull(req.params.id), extra]);
  } catch (e) { pgUnique(e, 'Такая программа уже есть в справочнике'); }
  res.json({ ok: true });
}));

router.delete('/software/:id', requireStaff, ah(async (req, res) => {
  await query('DELETE FROM software WHERE id = $1', [intOrNull(req.params.id)]);
  res.json({ ok: true });
}));

// ======================= СОСТОЯНИЯ ТЕХНИКИ =======================
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

router.get('/statuses', requireStaff, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT s.key, s.label, s.color, s.sort,
            (SELECT count(*) FROM devices d WHERE d.status = s.key)::int AS usage
       FROM device_statuses s ORDER BY s.sort, s.label`);
  res.json(rows);
}));

router.post('/statuses', requireStaff, ah(async (req, res) => {
  const label = str(req.body.label, 50);
  if (!label) throw new HttpError(400, 'Введите название состояния');
  const color = COLOR_RE.test(req.body.color || '') ? req.body.color : '#8993A4';
  const key = 's_' + crypto.randomBytes(4).toString('hex');
  try {
    await query(
      `INSERT INTO device_statuses (key, label, color, sort)
       VALUES ($1, $2, $3, COALESCE((SELECT max(sort) + 1 FROM device_statuses), 1))`, [key, label, color]);
  } catch (e) { pgUnique(e, 'Состояние с таким названием уже есть'); }
  res.status(201).json({ key, label, color });
}));

router.put('/statuses/:key', requireStaff, ah(async (req, res) => {
  const label = str(req.body.label, 50);
  if (!label) throw new HttpError(400, 'Введите название состояния');
  const color = COLOR_RE.test(req.body.color || '') ? req.body.color : '#8993A4';
  try {
    const { rowCount } = await query('UPDATE device_statuses SET label = $1, color = $2 WHERE key = $3',
      [label, color, req.params.key]);
    if (!rowCount) throw new HttpError(404, 'Состояние не найдено');
  } catch (e) { pgUnique(e, 'Состояние с таким названием уже есть'); }
  res.json({ ok: true });
}));

// Новый порядок: { keys: [...] }. Первое состояние — значение по умолчанию для новой техники
router.post('/statuses/reorder', requireStaff, ah(async (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : [];
  await tx(async (db) => {
    for (let i = 0; i < keys.length; i++) {
      await db.query('UPDATE device_statuses SET sort = $1 WHERE key = $2', [i + 1, keys[i]]);
    }
  });
  res.json({ ok: true });
}));

// Удаление. Если состояние используется — устройства переводятся в move_to (с записью в историю)
router.delete('/statuses/:key', requireStaff, ah(async (req, res) => {
  const key = req.params.key;
  const moveTo = req.query.move_to ? String(req.query.move_to) : null;
  await tx(async (db) => {
    const all = await loadStatuses(db);
    const cur = all.find((s) => s.key === key);
    if (!cur) throw new HttpError(404, 'Состояние не найдено');
    if (all.length < 2) throw new HttpError(400, 'Должно остаться хотя бы одно состояние');
    const used = (await db.query('SELECT count(*)::int AS n FROM devices WHERE status = $1', [key])).rows[0].n;
    if (used) {
      const target = all.find((s) => s.key === moveTo && s.key !== key);
      if (!target) throw new HttpError(400, `Состояние используется (${used} шт.) — выберите, в какое перевести эту технику`);
      const { rows } = await db.query(
        `UPDATE devices SET status = $1, updated_at = now(), updated_by = $2 WHERE status = $3 RETURNING id`,
        [target.key, req.user.id, key]);
      for (const r of rows) {
        await db.query(
          `INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'updated', $3)`,
          [r.id, req.user.id, JSON.stringify({ 'Состояние': [cur.label, target.label] })]);
      }
    }
    await db.query('DELETE FROM device_statuses WHERE key = $1', [key]);
  });
  res.json({ ok: true });
}));

// ======================= ТИПЫ ТЕХНИКИ =======================
function typeBody(b) {
  const name = str(b.name, 100);
  const code = str(b.code, 10);
  if (!name) throw new HttpError(400, 'Введите название типа');
  if (!code || !/^[A-Za-z0-9]+$/.test(code)) throw new HttpError(400, 'Код — латинские буквы/цифры, например PC');
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#0052CC';
  const fields = Array.isArray(b.fields) ? b.fields.filter((k) => CORE_KEYS.includes(k)) : CORE_KEYS;
  return [name, code.toUpperCase(), color, JSON.stringify(fields), Number(b.sort) || 0];
}

router.post('/types', requireStaff, ah(async (req, res) => {
  try {
    const { rows } = await query(
      'INSERT INTO device_types (name, code, color, fields, sort) VALUES ($1, $2, $3, $4, $5) RETURNING id', typeBody(req.body));
    res.status(201).json(rows[0]);
  } catch (e) { pgUnique(e, 'Тип с таким названием или кодом уже существует'); }
}));

router.put('/types/:id', requireStaff, ah(async (req, res) => {
  try {
    await query('UPDATE device_types SET name = $1, code = $2, color = $3, fields = $4, sort = $5 WHERE id = $6',
      [...typeBody(req.body), intOrNull(req.params.id)]);
  } catch (e) { pgUnique(e, 'Тип с таким названием или кодом уже существует'); }
  res.json({ ok: true });
}));

router.delete('/types/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const n = await query('SELECT count(*)::int AS n FROM devices WHERE type_id = $1', [id]);
  if (n.rows[0].n) throw new HttpError(400, `Нельзя удалить: есть устройства этого типа (${n.rows[0].n})`);
  await query('DELETE FROM device_types WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ======================= ДОПОЛНИТЕЛЬНЫЕ ПОЛЯ =======================
router.get('/fields', requireStaff, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT f.*, t.name AS type_name,
            CASE WHEN f.device_id IS NOT NULL THEN (SELECT dt.code || '-' || d.id FROM devices d JOIN device_types dt ON dt.id = d.type_id WHERE d.id = f.device_id) END AS device_key
       FROM field_defs f LEFT JOIN device_types t ON t.id = f.type_id
      ORDER BY CASE f.scope WHEN 'all' THEN 0 WHEN 'type' THEN 1 ELSE 2 END, f.sort, f.id`);
  res.json(rows);
}));

function fieldBody(b) {
  const label = str(b.label, 200);
  if (!label) throw new HttpError(400, 'Введите название поля');
  const type = FIELD_TYPES.includes(b.field_type) ? b.field_type : 'text';
  const options = type === 'select'
    ? (Array.isArray(b.options) ? b.options : String(b.options || '').split('\n'))
        .map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
    : [];
  if (type === 'select' && !options.length) throw new HttpError(400, 'Укажите варианты выбора');
  const lookupKind = type === 'lookup' ? String(b.lookup_kind || '') : null;
  if (type === 'lookup' && !lookupKind) throw new HttpError(400, 'Выберите справочник');
  return { label, type, options, lookupKind };
}

router.post('/fields', requireStaff, ah(async (req, res) => {
  const b = req.body;
  const f = fieldBody(b);
  const scope = ['all', 'type', 'device'].includes(b.scope) ? b.scope : 'all';
  const typeId = scope === 'type' ? intOrNull(b.type_id) : null;
  const deviceId = scope === 'device' ? intOrNull(b.device_id) : null;
  if (scope === 'type' && !typeId) throw new HttpError(400, 'Выберите тип техники');
  if (scope === 'device' && !deviceId) throw new HttpError(400, 'Не указано устройство');
  const { rows } = await query(
    `INSERT INTO field_defs (label, field_type, options, lookup_kind, scope, type_id, device_id, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT max(sort) + 1 FROM field_defs), 0), $8) RETURNING *`,
    [f.label, f.type, JSON.stringify(f.options), f.lookupKind, scope, typeId, deviceId, req.user.id]);
  res.status(201).json(rows[0]);
}));

router.put('/fields/:id', requireStaff, ah(async (req, res) => {
  const f = fieldBody(req.body);
  const { rowCount } = await query(
    `UPDATE field_defs SET label = $1, field_type = $2, options = $3, lookup_kind = $4,
            sort = COALESCE($5, sort) WHERE id = $6`,
    [f.label, f.type, JSON.stringify(f.options), f.lookupKind, req.body.sort == null ? null : Number(req.body.sort), intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Поле не найдено');
  res.json({ ok: true });
}));

router.delete('/fields/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await tx(async (db) => {
    await db.query('UPDATE devices SET extra = extra - $1::text WHERE extra ? $1::text', [String(id)]);
    await db.query('DELETE FROM field_defs WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

// ======================= ДОП. ПОЛЯ ПО =======================
const SW_TARGETS = ['software', 'install'];

router.get('/software-fields', requireStaff, ah(async (req, res) => {
  res.json(await loadSoftwareDefs({ query }));
}));

router.post('/software-fields', requireStaff, ah(async (req, res) => {
  const f = fieldBody(req.body);
  const target = SW_TARGETS.includes(req.body.target) ? req.body.target : null;
  if (!target) throw new HttpError(400, 'Выберите, к чему относится поле');
  const { rows } = await query(
    `INSERT INTO software_field_defs (label, field_type, options, lookup_kind, target, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(sort) + 1 FROM software_field_defs), 0), $6) RETURNING *`,
    [f.label, f.type, JSON.stringify(f.options), f.lookupKind, target, req.user.id]);
  res.status(201).json(rows[0]);
}));

router.put('/software-fields/:id', requireStaff, ah(async (req, res) => {
  const f = fieldBody(req.body);
  const { rowCount } = await query(
    'UPDATE software_field_defs SET label = $1, field_type = $2, options = $3, lookup_kind = $4 WHERE id = $5',
    [f.label, f.type, JSON.stringify(f.options), f.lookupKind, intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Поле не найдено');
  res.json({ ok: true });
}));

router.delete('/software-fields/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await tx(async (db) => {
    const { rows } = await db.query('DELETE FROM software_field_defs WHERE id = $1 RETURNING target', [id]);
    if (!rows[0]) throw new HttpError(404, 'Поле не найдено');
    const table = rows[0].target === 'software' ? 'software' : 'device_software';
    await db.query(`UPDATE ${table} SET extra = extra - $1::text WHERE extra ? $1::text`, [String(id)]);
  });
  res.json({ ok: true });
}));

// ======================= СОХРАНЁННЫЕ ФИЛЬТРЫ =======================
router.get('/filters', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.name, f.query, f.is_shared, f.user_id, u.username AS owner
       FROM saved_filters f JOIN users u ON u.id = f.user_id
      WHERE f.user_id = $1 OR f.is_shared ORDER BY f.name`, [req.user.id]);
  res.json(rows);
}));

router.post('/filters', ah(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Введите название фильтра');
  const shared = isStaff(req.user) && !!req.body.is_shared;
  const { rows } = await query(
    'INSERT INTO saved_filters (user_id, name, query, is_shared) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, name, JSON.stringify(req.body.query || {}), shared]);
  res.status(201).json(rows[0]);
}));

router.delete('/filters/:id', ah(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM saved_filters WHERE id = $1 AND (user_id = $2 OR $3)',
    [intOrNull(req.params.id), req.user.id, req.user.role === 'superadmin']);
  if (!rowCount) throw new HttpError(404, 'Фильтр не найден');
  res.json({ ok: true });
}));

module.exports = router;
