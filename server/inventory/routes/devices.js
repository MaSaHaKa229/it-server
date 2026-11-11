const express = require('express');
const { level } = require('../../portal/modules');
const { query, tx } = require('../db');
const { CORE_FIELDS, requireStaff, perms } = require('../access');
const { loadStatuses, resolveStatus, labelMap } = require('../statuses');
const { normalizeExtra, compactExtra, loadSoftwareDefs } = require('../extra');
const { buildDeviceQuery, sanitizeRow, loadGlobalDefs, LOOKUP_FIELDS, TEXT_FIELDS } = require('../deviceQuery');
const { HttpError, ah, str, intOrNull, parseJSON } = require('../util');
const { encrypt, decrypt } = require('../crypto');

const router = express.Router();
const STAFF_P = perms({ role: 'superadmin' });

async function addHistory(db, deviceId, userId, action, changes = {}) {
  await db.query(
    'INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, $3, $4)',
    [deviceId, userId, action, JSON.stringify(changes)]
  );
}

/** Загрузить одно устройство так, как его видит пользователь (или null) */
async function loadVisible(db, P, id, defs) {
  defs = defs || (await loadGlobalDefs(db));
  const b = buildDeviceQuery({ P, defs, id });
  const { rows } = await db.query(b.sql, b.params);
  if (!rows[0]) return null;
  return { row: sanitizeRow(rows[0], P, b.vis), vis: b.vis, defs };
}

async function ensureVisible(req, id) {
  const r = await loadVisible({ query }, req.perms, id);
  if (!r) throw new HttpError(404, 'Устройство не найдено');
  return r;
}

/** Все доп. поля, применимые к устройству (по типу и экземпляру) */
async function applicableDefs(db, typeId, deviceId) {
  const { rows } = await db.query(
    `SELECT id, label, field_type, options, lookup_kind, scope, type_id, device_id, sort
       FROM field_defs
      WHERE scope = 'all'
         OR (scope = 'type' AND type_id = $1)
         OR (scope = 'device' AND device_id = $2)
      ORDER BY CASE scope WHEN 'all' THEN 0 WHEN 'type' THEN 1 ELSE 2 END, sort, id`,
    [typeId, deviceId || 0]
  );
  return rows;
}

/** Разбор тела запроса в набор колонок devices */
async function parseDeviceBody(db, body, { partial }) {
  const cols = {};
  if (!partial || body.type_id !== undefined) {
    const typeId = intOrNull(body.type_id);
    if (!typeId) throw new HttpError(400, 'Не указан тип техники');
    const t = await db.query('SELECT id FROM device_types WHERE id = $1', [typeId]);
    if (!t.rows[0]) throw new HttpError(400, 'Неизвестный тип техники');
    cols.type_id = typeId;
  }
  if (!partial || body.status !== undefined) {
    cols.status = await resolveStatus(db, body.status);
  }
  for (const f of TEXT_FIELDS) {
    if (body[f.key] === undefined) continue;
    cols[f.key] = str(body[f.key], f.kind === 'textarea' ? 20000 : 500);
  }
  for (const f of LOOKUP_FIELDS) {
    if (body[f.col] === undefined) continue;
    const id = intOrNull(body[f.col]);
    if (id !== null) {
      const r = await db.query('SELECT 1 FROM lookups WHERE id = $1 AND kind = $2', [id, f.lookup]);
      if (!r.rows[0]) throw new HttpError(400, `Неверное значение поля «${f.label}»`);
    }
    cols[f.col] = id;
  }
  return cols;
}

/** Отображаемые значения — для истории изменений */
function displayMap(row, defs) {
  const m = { 'Тип': row.type_name, 'Состояние': row.status_label || row.status };
  for (const f of CORE_FIELDS) m[f.label] = row[f.key] ?? null;
  const byId = Object.fromEntries(defs.map((d) => [String(d.id), d.label]));
  for (const [k, v] of Object.entries(row.extra || {})) m[byId[k] || `Поле #${k}`] = v;
  for (const d of defs) if (!(d.label in m)) m[d.label] = null;
  return m;
}

function diff(before, after) {
  const ch = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k] ?? null, b = after[k] ?? null;
    if (String(a) !== String(b)) ch[k] = [a, b];
  }
  return ch;
}

// =================== Список ===================
router.get('/', ah(async (req, res) => {
  const P = req.perms;
  const defs = await loadGlobalDefs({ query });
  const b = buildDeviceQuery({
    P, defs,
    q: req.query.q,
    filters: parseJSON(req.query.filters, {}),
    sort: req.query.sort,
    dir: req.query.dir,
    limit: Math.min(Number(req.query.limit) || 50, 500),
    offset: Number(req.query.offset) || 0,
  });
  const [rows, count] = await Promise.all([query(b.sql, b.params), query(b.countSql, b.countParams)]);
  res.json({ total: count.rows[0].total, items: rows.rows.map((r) => sanitizeRow(r, P, b.vis)) });
}));

// =================== Статистика для дашборда ===================
router.get('/stats', ah(async (req, res) => {
  const P = req.perms;
  const params = [];
  const where = [];
  if (P.types !== null) { params.push(P.types); where.push(`d.type_id = ANY($${params.length}::int[])`); }
  if (P.departments !== null) { params.push(P.departments); where.push(`d.department_id = ANY($${params.length}::int[])`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const byType = await query(
    `SELECT t.id, t.name, t.code, t.color, d.status, count(*)::int AS n
       FROM devices d JOIN device_types t ON t.id = d.type_id ${w}
      GROUP BY t.id, t.name, t.code, t.color, d.status ORDER BY t.id`, params);
  const recent = await query(
    `SELECT d.id, d.hostname, d.status, d.updated_at, t.code AS type_code, t.name AS type_name, t.color AS type_color
       FROM devices d JOIN device_types t ON t.id = d.type_id ${w}
      ORDER BY d.updated_at DESC LIMIT 10`, params);
  let byDept = { rows: [] };
  if (P.fields === null || P.fields.includes('department')) {
    byDept = await query(
      `SELECT COALESCE(l.value, '— без отдела —') AS name, count(*)::int AS n
         FROM devices d LEFT JOIN lookups l ON l.id = d.department_id ${w}
        GROUP BY l.value ORDER BY n DESC LIMIT 10`, params);
  }
  res.json({ byType: byType.rows, recent: recent.rows, byDept: byDept.rows });
}));

// =================== Карточка устройства ===================
router.get('/:id', ah(async (req, res) => {
  const P = req.perms;
  const id = intOrNull(req.params.id);
  const r = await loadVisible({ query }, P, id);
  if (!r) throw new HttpError(404, 'Устройство не найдено');
  const { row, vis } = r;

  const allDefs = await applicableDefs({ query }, row.type_id, id);
  const fields = allDefs.filter((d) =>
    d.scope === 'device' ? vis.instance : (!vis.restricted || vis.visibleIds.has(String(d.id))));

  const out = { device: row, fields };
  if (P.software) {
    out.software = (await query(
      `SELECT ds.id, ds.software_id, s.name, s.vendor, ds.version, ds.license_key, ds.installed_at, ds.note,
              ds.extra, s.extra AS software_extra
         FROM device_software ds JOIN software s ON s.id = ds.software_id
        WHERE ds.device_id = $1 ORDER BY s.name`, [id])).rows;
  }
  if (P.passwords) {
    out.credentials = (await query(
      `SELECT c.id, c.title, c.login, c.note, c.updated_at, CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE u.username END AS updated_by
         FROM device_credentials c LEFT JOIN users u ON u.id = c.updated_by
        WHERE c.device_id = $1 ORDER BY c.id`, [id])).rows;
  }
  // Заявки helpdesk, к которым привязана техника — тем, у кого есть доступ к заявкам
  if (level(req.user, 'helpdesk') !== 'none') {
    out.tickets = (await query(
      `SELECT t.id, t.title, t.created_at, t.closed_at, s.name AS status_name, s.color AS status_color, s.is_closed,
              r.full_name AS requester_name, r.department AS requester_department,
              CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS assignee_name
         FROM helpdesk.ticket_devices td
         JOIN helpdesk.tickets t ON t.id = td.ticket_id
         JOIN helpdesk.statuses s ON s.id = t.status_id
         JOIN helpdesk.requesters r ON r.id = t.requester_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE td.device_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [id])).rows;
  }
  if (P.history) {
    out.history = (await query(
      `SELECT h.id, h.action, h.changes, h.created_at,
              CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE u.username END AS username,
              CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE u.full_name END AS full_name
         FROM device_history h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.device_id = $1 ORDER BY h.created_at DESC LIMIT 200`, [id])).rows;
  }
  res.json(out);
}));

// =================== Создание ===================
router.post('/', requireStaff, ah(async (req, res) => {
  const id = await tx(async (db) => {
    const cols = await parseDeviceBody(db, req.body, { partial: false });
    const defs = await applicableDefs(db, cols.type_id, 0);
    const extra = normalizeExtra(req.body.extra, defs);
    for (const k of Object.keys(extra)) if (extra[k] === null) delete extra[k];
    cols.extra = JSON.stringify(extra);
    cols.created_by = req.user.id;
    cols.updated_by = req.user.id;
    const keys = Object.keys(cols);
    const { rows } = await db.query(
      `INSERT INTO devices (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
      keys.map((k) => cols[k])
    );
    await addHistory(db, rows[0].id, req.user.id, 'created');
    return rows[0].id;
  });
  res.status(201).json({ id });
}));

// =================== Изменение ===================
/** Изменить устройство (как в карточке): поля, доп. поля; изменения — в историю. Возвращает изменения */
async function updateDevice(db, id, body, userId) {
  {
    const cur = await db.query('SELECT type_id, extra FROM devices WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new HttpError(404, 'Устройство не найдено');
    const cols = await parseDeviceBody(db, body, { partial: true });
    const typeId = cols.type_id || cur.rows[0].type_id;
    const defs = await applicableDefs(db, typeId, id);

    const beforeRow = (await loadVisible(db, STAFF_P, id)).row;

    if (body.extra !== undefined) {
      const changes = normalizeExtra(body.extra, defs);
      const extra = { ...cur.rows[0].extra };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete extra[k]; else extra[k] = v;
      }
      cols.extra = JSON.stringify(extra);
    }
    if (!Object.keys(cols).length) return {};
    cols.updated_by = userId;
    const keys = Object.keys(cols);
    await db.query(
      `UPDATE devices SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => cols[k]), id]
    );
    const afterRow = (await loadVisible(db, STAFF_P, id)).row;
    const ch = diff(displayMap(beforeRow, defs), displayMap(afterRow, defs));
    if (Object.keys(ch).length) await addHistory(db, id, userId, 'updated', ch);
    return ch;
  }
}

router.patch('/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await tx((db) => updateDevice(db, id, req.body, req.user.id));
  res.json({ ok: true });
}));

// =================== Массовые действия ===================
router.post('/bulk', requireStaff, ah(async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new HttpError(400, 'Не выбраны устройства');
  const { action, value } = req.body;
  await tx(async (db) => {
    if (action === 'status') {
      if (!value) throw new HttpError(400, 'Не указано состояние');
      await resolveStatus(db, value);
      const L = labelMap(await loadStatuses(db));
      const { rows } = await db.query(
        `UPDATE devices d SET status = $1, updated_at = now(), updated_by = $2
           FROM devices old WHERE d.id = old.id AND d.id = ANY($3::int[]) AND old.status <> $1
         RETURNING d.id, old.status AS old_status`, [value, req.user.id, ids]);
      for (const r of rows) {
        await addHistory(db, r.id, req.user.id, 'updated',
          { 'Состояние': [L[r.old_status] || r.old_status, L[value]] });
      }
    } else if (action === 'update') {
      // Массовое изменение полей: value — те же поля, что в карточке (тип и состояние — отдельно)
      const v = value && typeof value === 'object' ? { ...value } : {};
      delete v.type_id;
      if (!Object.keys(v).length) throw new HttpError(400, 'Не выбрано ни одного поля');
      for (const id of ids) await updateDevice(db, id, v, req.user.id);
    } else if (action === 'delete') {
      await db.query('DELETE FROM devices WHERE id = ANY($1::int[])', [ids]);
    } else {
      throw new HttpError(400, 'Неизвестное действие');
    }
  });
  res.json({ ok: true });
}));

// =================== Копирование ===================
router.post('/:id/clone', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const newId = await tx(async (db) => {
    const cols = ['type_id', 'model_id', 'cpu_id', 'ram_id', 'storage_id', 'os_id', 'department_id',
      'location_id', 'specs', 'status', 'notes'];
    const { rows } = await db.query(
      `INSERT INTO devices (${cols.join(', ')}, extra, created_by, updated_by)
       SELECT ${cols.join(', ')},
              COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(extra) e
                         WHERE e.key NOT IN (SELECT id::text FROM field_defs WHERE device_id = $1)), '{}'::jsonb),
              $2, $2
         FROM devices WHERE id = $1 RETURNING id`, [id, req.user.id]);
    if (!rows[0]) throw new HttpError(404, 'Устройство не найдено');
    await db.query(
      `INSERT INTO device_software (device_id, software_id, version, installed_at, note, extra)
       SELECT $1, software_id, version, installed_at, note, extra FROM device_software WHERE device_id = $2`,
      [rows[0].id, id]);
    await addHistory(db, rows[0].id, req.user.id, 'created', { 'Скопировано из': [null, `#${id}`] });
    return rows[0].id;
  });
  res.status(201).json({ id: newId });
}));

// =================== Удаление ===================
router.delete('/:id', requireStaff, ah(async (req, res) => {
  const { rowCount } = await query('DELETE FROM devices WHERE id = $1', [intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Устройство не найдено');
  res.json({ ok: true });
}));

// =================== Установленное ПО ===================
async function resolveSoftware(db, body) {
  let swId = intOrNull(body.software_id);
  if (!swId) {
    const name = str(body.software_name, 300);
    if (!name) throw new HttpError(400, 'Укажите программу');
    const { rows } = await db.query(
      `INSERT INTO software (name, vendor) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, str(body.vendor, 300)]);
    swId = rows[0].id;
  }
  const { rows } = await db.query('SELECT id, name FROM software WHERE id = $1', [swId]);
  if (!rows[0]) throw new HttpError(400, 'Программа не найдена');
  return rows[0];
}

router.post('/:id/software', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body;
  const out = await tx(async (db) => {
    const d = await db.query('SELECT 1 FROM devices WHERE id = $1', [id]);
    if (!d.rows[0]) throw new HttpError(404, 'Устройство не найдено');
    const sw = await resolveSoftware(db, b);
    const extra = compactExtra(b.extra, await loadSoftwareDefs(db, 'install'));
    const { rows } = await db.query(
      `INSERT INTO device_software (device_id, software_id, version, license_key, installed_at, note, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [id, sw.id, str(b.version, 100), str(b.license_key, 500), str(b.installed_at, 10), str(b.note, 2000), JSON.stringify(extra)]);
    await addHistory(db, id, req.user.id, 'software_added', { 'ПО': [null, sw.name + (b.version ? ' ' + b.version : '')] });
    await db.query('UPDATE devices SET updated_at = now(), updated_by = $2 WHERE id = $1', [id, req.user.id]);
    return rows[0];
  });
  res.status(201).json(out);
}));

router.put('/:id/software/:sid', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id), sid = intOrNull(req.params.sid);
  const b = req.body;
  await tx(async (db) => {
    const sw = await resolveSoftware(db, b);
    // Если доп. поля не переданы — оставляем как есть
    const extra = b.extra === undefined ? null : JSON.stringify(compactExtra(b.extra, await loadSoftwareDefs(db, 'install')));
    const { rowCount } = await db.query(
      `UPDATE device_software SET software_id = $1, version = $2, license_key = $3, installed_at = $4, note = $5,
              extra = COALESCE($8::jsonb, extra)
        WHERE id = $6 AND device_id = $7`,
      [sw.id, str(b.version, 100), str(b.license_key, 500), str(b.installed_at, 10), str(b.note, 2000), sid, id, extra]);
    if (!rowCount) throw new HttpError(404, 'Запись не найдена');
    await addHistory(db, id, req.user.id, 'software_updated', { 'ПО': [null, sw.name + (b.version ? ' ' + b.version : '')] });
  });
  res.json({ ok: true });
}));

router.delete('/:id/software/:sid', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id), sid = intOrNull(req.params.sid);
  await tx(async (db) => {
    const { rows } = await db.query(
      `DELETE FROM device_software ds USING software s
        WHERE ds.id = $1 AND ds.device_id = $2 AND s.id = ds.software_id
       RETURNING s.name, ds.version`, [sid, id]);
    if (!rows[0]) throw new HttpError(404, 'Запись не найдена');
    await addHistory(db, id, req.user.id, 'software_removed',
      { 'ПО': [rows[0].name + (rows[0].version ? ' ' + rows[0].version : ''), null] });
  });
  res.json({ ok: true });
}));

// =================== Пароли ===================
router.get('/:id/credentials/:cid/secret', ah(async (req, res) => {
  if (!req.perms.passwords) throw new HttpError(403, 'Нет доступа к паролям');
  const id = intOrNull(req.params.id), cid = intOrNull(req.params.cid);
  await ensureVisible(req, id);
  const { rows } = await query('SELECT title, secret_enc FROM device_credentials WHERE id = $1 AND device_id = $2', [cid, id]);
  if (!rows[0]) throw new HttpError(404, 'Запись не найдена');
  let secret;
  try { secret = decrypt(rows[0].secret_enc); } catch { throw new HttpError(500, 'Не удалось расшифровать пароль (изменён APP_SECRET_KEY?)'); }
  await addHistory({ query }, id, req.user.id, 'password_viewed', { 'Пароль': [null, rows[0].title] });
  res.json({ secret });
}));

router.post('/:id/credentials', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body;
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Укажите назначение пароля');
  if (!b.password) throw new HttpError(400, 'Укажите пароль');
  const d = await query('SELECT 1 FROM devices WHERE id = $1', [id]);
  if (!d.rows[0]) throw new HttpError(404, 'Устройство не найдено');
  const { rows } = await query(
    `INSERT INTO device_credentials (device_id, title, login, secret_enc, note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [id, title, str(b.login, 200), encrypt(b.password), str(b.note, 2000), req.user.id]);
  await addHistory({ query }, id, req.user.id, 'password_added', { 'Пароль': [null, title] });
  res.status(201).json(rows[0]);
}));

router.put('/:id/credentials/:cid', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id), cid = intOrNull(req.params.cid);
  const b = req.body;
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Укажите назначение пароля');
  const params = [title, str(b.login, 200), str(b.note, 2000), req.user.id, cid, id];
  let setSecret = '';
  if (b.password) { params.push(encrypt(b.password)); setSecret = `, secret_enc = $${params.length}`; }
  const { rowCount } = await query(
    `UPDATE device_credentials SET title = $1, login = $2, note = $3, updated_by = $4, updated_at = now()${setSecret}
      WHERE id = $5 AND device_id = $6`, params);
  if (!rowCount) throw new HttpError(404, 'Запись не найдена');
  await addHistory({ query }, id, req.user.id, 'password_updated', { 'Пароль': [null, title] });
  res.json({ ok: true });
}));

router.delete('/:id/credentials/:cid', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id), cid = intOrNull(req.params.cid);
  const { rows } = await query('DELETE FROM device_credentials WHERE id = $1 AND device_id = $2 RETURNING title', [cid, id]);
  if (!rows[0]) throw new HttpError(404, 'Запись не найдена');
  await addHistory({ query }, id, req.user.id, 'password_removed', { 'Пароль': [rows[0].title, null] });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.loadVisible = loadVisible;
module.exports.updateDevice = updateDevice;
