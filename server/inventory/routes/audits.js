// Инвентаризация: плановая проверка наличия техники на выбранную дату (редакторы и администратор).
// Создаётся по отбору (типы, отделы, расположения), список техники фиксируется на момент создания;
// по каждому устройству — отметка «на месте» / «не найдено» / «в другом месте» и комментарий; отчёт — Excel.
const express = require('express');
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { HttpError, ah, str, intOrNull } = require('../util');

const router = express.Router();

const STATES = { pending: 'не проверено', found: 'на месте', missing: 'не найдено', moved: 'в другом месте' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []);

const SUMMARY = `
  SELECT a.id, a.title, to_char(a.planned_date, 'YYYY-MM-DD') AS planned_date, a.status, a.filters, a.note,
         a.created_at, a.finished_at,
         COALESCE(NULLIF(cu.full_name, ''), cu.username) AS created_by_name, cu.is_service AS created_by_system,
         COALESCE(NULLIF(fu.full_name, ''), fu.username) AS finished_by_name, fu.is_service AS finished_by_system,
         (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id) AS total,
         (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.state = 'pending') AS pending,
         (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.state = 'found') AS found,
         (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.state = 'missing') AS missing,
         (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.state = 'moved') AS moved
    FROM inventory_audits a
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users fu ON fu.id = a.finished_by`;

const nameOf = (name, system) => (system ? 'Служба ИТ' : name);
const view = (a) => ({
  ...a,
  created_by_name: nameOf(a.created_by_name, a.created_by_system),
  finished_by_name: nameOf(a.finished_by_name, a.finished_by_system),
  created_by_system: undefined, finished_by_system: undefined,
});

// Сведения об устройстве (как в карточке), снимок — на момент создания инвентаризации
const DEVICE_SQL = `
  SELECT d.id, t.code AS type_code, t.name AS type_name, t.color AS type_color, d.hostname, d.inv_number, d.serial_number,
         d.status, lm.value AS model, le.value AS employee, ll.value AS location, ld.value AS department, wp.name AS workplace
    FROM devices d JOIN device_types t ON t.id = d.type_id
    LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups le ON le.id = d.employee_id
    LEFT JOIN lookups ll ON ll.id = d.location_id LEFT JOIN lookups ld ON ld.id = d.department_id
    LEFT JOIN workplaces wp ON wp.id = d.workplace_id`;

async function getAudit(id) {
  const { rows } = await query(`${SUMMARY} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Инвентаризация не найдена');
  return view(rows[0]);
}

router.get('/', ah(async (req, res) => {
  const { rows } = await query(`${SUMMARY} ORDER BY (a.status = 'open') DESC, a.planned_date DESC, a.id DESC`);
  res.json(rows.map(view));
}));

// Сколько техники попадёт в инвентаризацию при таком отборе (для формы создания)
router.post('/preview', ah(async (req, res) => {
  const { where, vals } = filterSql(req.body.filters || {});
  const { rows } = await query(`SELECT count(*)::int AS n FROM devices d WHERE ${where}`, vals);
  res.json({ count: rows[0].n });
}));

function filterSql(f) {
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (ids(f.types).length) add('d.type_id = ANY(?::int[])', ids(f.types));
  if (ids(f.departments).length) add('d.department_id = ANY(?::int[])', ids(f.departments));
  if (ids(f.locations).length) add('d.location_id = ANY(?::int[])', ids(f.locations));
  if (!f.include_written_off) where.push(`d.status <> 'written_off'`);
  return { where: where.length ? where.join(' AND ') : 'TRUE', vals };
}

router.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Укажите название инвентаризации');
  if (!DAY.test(String(b.planned_date || ''))) throw new HttpError(400, 'Укажите дату проведения');
  const f = b.filters || {};
  const filters = { types: ids(f.types), departments: ids(f.departments), locations: ids(f.locations), include_written_off: !!f.include_written_off };
  const { where, vals } = filterSql(filters);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [a] } = await client.query(
      `INSERT INTO inventory_audits (title, planned_date, filters, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, b.planned_date, JSON.stringify(filters), str(b.note, 2000) || '', req.user.id]);
    const { rows: devs } = await client.query(`${DEVICE_SQL} WHERE ${where} ORDER BY ll.value NULLS LAST, d.id`, vals);
    if (!devs.length) throw new HttpError(400, 'По такому отбору нет техники');
    await client.query(
      `INSERT INTO inventory_audit_items (audit_id, device_id, snapshot)
       SELECT $1, (x->>'id')::int, x FROM jsonb_array_elements($2::jsonb) x`, [a.id, JSON.stringify(devs)]);
    await client.query('COMMIT');
    res.status(201).json(await getAudit(a.id));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

router.get('/:id', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  const { rows } = await query(
    `SELECT i.device_id, i.state, i.note, i.checked_at, i.snapshot,
            COALESCE(NULLIF(u.full_name, ''), u.username) AS checked_by_name, u.is_service AS checked_by_system,
            cur.hostname, cur.model, cur.employee, cur.location, cur.department, cur.workplace, cur.status, cur.inv_number, cur.serial_number,
            cur.type_code, cur.type_name, cur.type_color, cur.id IS NULL AS deleted
       FROM inventory_audit_items i
       LEFT JOIN users u ON u.id = i.checked_by
       LEFT JOIN (${DEVICE_SQL}) cur ON cur.id = i.device_id
      WHERE i.audit_id = $1
      ORDER BY COALESCE(cur.location, i.snapshot->>'location') NULLS LAST, i.device_id`, [a.id]);
  res.json({
    audit: a,
    items: rows.map((r) => ({ ...r, checked_by_name: nameOf(r.checked_by_name, r.checked_by_system), checked_by_system: undefined })),
    states: STATES,
  });
}));

router.patch('/:id', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  const b = req.body || {};
  const title = 'title' in b ? str(b.title, 200) : a.title;
  if (!title) throw new HttpError(400, 'Укажите название инвентаризации');
  const date = 'planned_date' in b ? b.planned_date : a.planned_date;
  if (!DAY.test(String(date))) throw new HttpError(400, 'Укажите дату проведения');
  await query('UPDATE inventory_audits SET title = $2, planned_date = $3, note = $4 WHERE id = $1',
    [a.id, title, date, 'note' in b ? str(b.note, 2000) || '' : a.note]);
  res.json(await getAudit(a.id));
}));

// Отметка по устройству
router.patch('/:id/items/:deviceId', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  if (a.status !== 'open') throw new HttpError(400, 'Инвентаризация завершена — откройте её снова, чтобы менять отметки');
  const b = req.body || {};
  const sets = [];
  const vals = [a.id, intOrNull(req.params.deviceId)];
  if ('state' in b) {
    if (!STATES[b.state]) throw new HttpError(400, 'Неверная отметка');
    vals.push(b.state); sets.push(`state = $${vals.length}`);
    vals.push(b.state === 'pending' ? null : req.user.id); sets.push(`checked_by = $${vals.length}`);
    sets.push(`checked_at = ${b.state === 'pending' ? 'NULL' : 'now()'}`);
  }
  if ('note' in b) { vals.push(str(b.note, 1000) || ''); sets.push(`note = $${vals.length}`); }
  if (!sets.length) throw new HttpError(400, 'Нет изменений');
  const { rowCount } = await query(`UPDATE inventory_audit_items SET ${sets.join(', ')} WHERE audit_id = $1 AND device_id = $2`, vals);
  if (!rowCount) throw new HttpError(404, 'Устройства нет в этой инвентаризации');
  res.json({ ok: true });
}));

// Отметить все непроверенные разом (например, «всё остальное на месте»)
router.post('/:id/mark-rest', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  if (a.status !== 'open') throw new HttpError(400, 'Инвентаризация завершена');
  const state = STATES[req.body.state] && req.body.state !== 'pending' ? req.body.state : 'found';
  const { rowCount } = await query(
    `UPDATE inventory_audit_items SET state = $2, checked_by = $3, checked_at = now() WHERE audit_id = $1 AND state = 'pending'`,
    [a.id, state, req.user.id]);
  res.json({ updated: rowCount });
}));

// Добавить устройство, найденное на месте, но не попавшее в список
router.post('/:id/items', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  if (a.status !== 'open') throw new HttpError(400, 'Инвентаризация завершена');
  const id = intOrNull(req.body.device_id);
  const { rows } = await query(`${DEVICE_SQL} WHERE d.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Устройство не найдено');
  await query(
    `INSERT INTO inventory_audit_items (audit_id, device_id, snapshot, state, checked_by, checked_at, note)
     VALUES ($1, $2, $3, 'found', $4, now(), 'добавлено при проверке') ON CONFLICT DO NOTHING`,
    [a.id, id, JSON.stringify(rows[0]), req.user.id]);
  res.status(201).json({ ok: true });
}));

router.delete('/:id/items/:deviceId', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  if (a.status !== 'open') throw new HttpError(400, 'Инвентаризация завершена');
  await query('DELETE FROM inventory_audit_items WHERE audit_id = $1 AND device_id = $2', [a.id, intOrNull(req.params.deviceId)]);
  res.json({ ok: true });
}));

// Завершить: результат записывается в историю техники («не найдено» / «в другом месте» / «на месте»)
router.post('/:id/finish', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  if (a.status !== 'open') throw new HttpError(400, 'Инвентаризация уже завершена');
  if (a.pending && !req.body.force) throw new HttpError(409, `Не проверено устройств: ${a.pending}. Отметьте их или подтвердите завершение.`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE inventory_audits SET status = 'done', finished_at = now(), finished_by = $2 WHERE id = $1`, [a.id, req.user.id]);
    await client.query(
      `INSERT INTO device_history (device_id, user_id, action, changes)
       SELECT i.device_id, $2, 'audit', jsonb_build_object('Инвентаризация', jsonb_build_array(NULL,
                $3 || ': ' || CASE i.state WHEN 'found' THEN 'на месте' WHEN 'missing' THEN 'не найдено'
                                           WHEN 'moved' THEN 'в другом месте' ELSE 'не проверено' END
                || CASE WHEN i.note <> '' THEN ' (' || i.note || ')' ELSE '' END))
         FROM inventory_audit_items i JOIN devices d ON d.id = i.device_id WHERE i.audit_id = $1`,
      [a.id, req.user.id, `${a.title} от ${a.planned_date.split('-').reverse().join('.')}`]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json(await getAudit(a.id));
}));

router.post('/:id/reopen', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  await query(`UPDATE inventory_audits SET status = 'open', finished_at = NULL, finished_by = NULL WHERE id = $1`, [a.id]);
  res.json(await getAudit(a.id));
}));

router.delete('/:id', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  await query('DELETE FROM inventory_audits WHERE id = $1', [a.id]);
  res.json({ ok: true });
}));

// Отчёт в Excel
router.get('/:id/export.xlsx', ah(async (req, res) => {
  const a = await getAudit(intOrNull(req.params.id));
  const { rows } = await query(
    `SELECT i.*, COALESCE(NULLIF(u.full_name, ''), u.username) AS checked_by_name, u.is_service AS sys
       FROM inventory_audit_items i LEFT JOIN users u ON u.id = i.checked_by
      WHERE i.audit_id = $1 ORDER BY i.snapshot->>'location' NULLS LAST, i.device_id`, [a.id]);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IT Portal';
  const ws = wb.addWorksheet('Инвентаризация', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow([`Инвентаризация: ${a.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`Дата проведения: ${a.planned_date.split('-').reverse().join('.')}. Всего: ${a.total}, на месте: ${a.found}, `
    + `не найдено: ${a.missing}, в другом месте: ${a.moved}, не проверено: ${a.pending}.${a.status === 'done' ? ' Завершена.' : ''}`]);
  ws.addRow([]);
  ws.columns = [
    { key: 'key', width: 10 }, { key: 'type', width: 14 }, { key: 'hostname', width: 20 }, { key: 'model', width: 26 },
    { key: 'inv', width: 14 }, { key: 'serial', width: 18 }, { key: 'employee', width: 24 }, { key: 'location', width: 18 },
    { key: 'department', width: 20 }, { key: 'state', width: 16 }, { key: 'note', width: 30 }, { key: 'by', width: 22 }, { key: 'at', width: 17 },
  ];
  const head = ws.addRow(['Ключ', 'Тип', 'Сетевое имя', 'Модель', 'Инв. №', 'Серийный №', 'Пользователь', 'Расположение', 'Отдел',
    'Результат', 'Комментарий', 'Проверил', 'Когда']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  const COLORS = { found: 'FFE3FCEF', missing: 'FFFFEBE6', moved: 'FFFFF0B3' };
  for (const r of rows) {
    const s = r.snapshot || {};
    const row = ws.addRow([`${s.type_code}-${r.device_id}`, s.type_name, s.hostname, s.model, s.inv_number, s.serial_number, s.employee,
      s.location, s.department, STATES[r.state], r.note, r.checked_at ? nameOf(r.checked_by_name, r.sys) : '', r.checked_at || '']);
    if (COLORS[r.state]) row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[r.state] } };
  }
  ws.getColumn(13).numFmt = 'dd.mm.yyyy hh:mm';
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 13 } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="inventory-audit-${a.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
