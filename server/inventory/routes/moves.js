// Перемещения техники: в другой кабинет, другому сотруднику, в другой отдел, на другое рабочее место.
// Каждое перемещение — строка device_moves (дата, было → стало, основание) и запись в истории техники.
const express = require('express');
const ExcelJS = require('exceljs');
const { query, tx } = require('../db');
const { requireStaff } = require('../access');
const { HttpError, ah, str, intOrNull } = require('../util');

const router = express.Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Что можно менять при перемещении: поле → [колонка, вид справочника, подпись]
const FIELDS = {
  location: ['location_id', 'location', 'Расположение'],
  employee: ['employee_id', 'employee', 'Пользователь'],
  department: ['department_id', 'department', 'Отдел'],
};

/** Видимость техники для читателя (типы и отделы) */
function visible(P, vals) {
  const w = [];
  if (P.types !== null) { vals.push(P.types); w.push(`d.type_id = ANY($${vals.length}::int[])`); }
  if (P.departments !== null) { vals.push(P.departments); w.push(`d.department_id = ANY($${vals.length}::int[])`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

// Переместить одну или несколько единиц техники
router.post('/', requireStaff, ah(async (req, res) => {
  const b = req.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
  if (!ids.length) throw new HttpError(400, 'Не выбрана техника');
  const movedOn = DAY.test(String(b.moved_on || '')) ? b.moved_on : new Date().toISOString().slice(0, 10);
  const note = str(b.note, 1000) || '';
  const set = b.set || {};
  if (!Object.keys(set).length) throw new HttpError(400, 'Укажите, что меняется: расположение, сотрудник, отдел или рабочее место');
  const n = await tx(async (db) => {
    // Новые значения (null — очистить)
    const target = {};
    for (const [k, [, kind, label]] of Object.entries(FIELDS)) {
      if (!(k in set)) continue;
      const id = intOrNull(set[k]);
      let name = null;
      if (id) {
        const r = await db.query('SELECT value FROM lookups WHERE id = $1 AND kind = $2', [id, kind]);
        if (!r.rows[0]) throw new HttpError(400, `Неверное значение поля «${label}»`);
        name = r.rows[0].value;
      }
      target[k] = { id, name };
    }
    if ('workplace' in set) {
      const id = intOrNull(set.workplace);
      let name = null;
      if (id) {
        const r = await db.query('SELECT name FROM workplaces WHERE id = $1', [id]);
        if (!r.rows[0]) throw new HttpError(400, 'Рабочее место не найдено');
        name = r.rows[0].name;
      }
      target.workplace = { id, name };
    }
    const { rows } = await db.query(
      `SELECT d.id, d.location_id, d.employee_id, d.department_id, d.workplace_id,
              ll.value AS location, le.value AS employee, ld.value AS department, w.name AS workplace
         FROM devices d
         LEFT JOIN lookups ll ON ll.id = d.location_id LEFT JOIN lookups le ON le.id = d.employee_id
         LEFT JOIN lookups ld ON ld.id = d.department_id LEFT JOIN workplaces w ON w.id = d.workplace_id
        WHERE d.id = ANY($1::int[]) FOR UPDATE OF d`, [ids]);
    let count = 0;
    for (const d of rows) {
      const changes = {};
      const sets = [];
      const vals = [d.id];
      for (const [k, t] of Object.entries(target)) {
        const col = k === 'workplace' ? 'workplace_id' : FIELDS[k][0];
        if ((d[col] || null) === (t.id || null)) continue;
        const label = k === 'workplace' ? 'Рабочее место' : FIELDS[k][2];
        changes[label] = [d[k] || null, t.name];
        vals.push(t.id); sets.push(`${col} = $${vals.length}`);
      }
      if (!sets.length) continue;
      vals.push(req.user.id);
      await db.query(`UPDATE devices SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length} WHERE id = $1`, vals);
      await db.query('INSERT INTO device_moves (device_id, moved_on, changes, note, user_id) VALUES ($1, $2, $3, $4, $5)',
        [d.id, movedOn, JSON.stringify(changes), note, req.user.id]);
      const hist = { ...changes, 'Дата перемещения': [null, movedOn.split('-').reverse().join('.')] };
      if (note) hist['Основание'] = [null, note];
      await db.query(`INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'moved', $3)`,
        [d.id, req.user.id, JSON.stringify(hist)]);
      count++;
    }
    return count;
  });
  res.json({ moved: n });
}));

// Журнал перемещений (отчёт): период, поиск, одно устройство
async function list(req) {
  const q = req.query;
  const vals = [];
  const where = ['TRUE'];
  if (q.from && DAY.test(q.from)) { vals.push(q.from); where.push(`m.moved_on >= $${vals.length}::date`); }
  if (q.to && DAY.test(q.to)) { vals.push(q.to); where.push(`m.moved_on <= $${vals.length}::date`); }
  if (q.device) { vals.push(intOrNull(q.device)); where.push(`m.device_id = $${vals.length}`); }
  if (q.q) {
    vals.push(`%${String(q.q).slice(0, 100)}%`);
    const p = `$${vals.length}`;
    where.push(`(d.hostname ILIKE ${p} OR d.inv_number ILIKE ${p} OR lm.value ILIKE ${p} OR m.changes::text ILIKE ${p} OR m.note ILIKE ${p}
                 OR (t.code || '-' || d.id) ILIKE ${p})`);
  }
  const vis = visible(req.perms, vals);
  const { rows } = await query(
    `SELECT m.id, m.device_id, to_char(m.moved_on, 'YYYY-MM-DD') AS moved_on, m.changes, m.note, m.created_at,
            t.code AS type_code, t.name AS type_name, t.color AS type_color, d.hostname, d.inv_number, lm.value AS model,
            CASE WHEN u.is_service THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS user_name
       FROM device_moves m JOIN devices d ON d.id = m.device_id JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN users u ON u.id = m.user_id
      WHERE ${where.join(' AND ')}${vis}
      ORDER BY m.moved_on DESC, m.id DESC LIMIT 5000`, vals);
  return rows;
}

router.get('/', ah(async (req, res) => res.json(await list(req))));

router.get('/export.xlsx', ah(async (req, res) => {
  const rows = await list(req);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Перемещения', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Дата', key: 'date', width: 12 }, { header: 'Ключ', key: 'key', width: 10 }, { header: 'Устройство', key: 'dev', width: 26 },
    { header: 'Инв. №', key: 'inv', width: 14 },
    { header: 'Расположение: было', key: 'l0', width: 18 }, { header: 'стало', key: 'l1', width: 18 },
    { header: 'Пользователь: был', key: 'e0', width: 22 }, { header: 'стал', key: 'e1', width: 22 },
    { header: 'Отдел: был', key: 'd0', width: 20 }, { header: 'стал', key: 'd1', width: 20 },
    { header: 'Рабочее место: было', key: 'w0', width: 20 }, { header: 'стало', key: 'w1', width: 20 },
    { header: 'Основание', key: 'note', width: 30 }, { header: 'Кто', key: 'who', width: 22 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  for (const r of rows) {
    const c = r.changes || {};
    const g = (k, i) => (c[k] ? c[k][i] || '—' : '');
    ws.addRow({
      date: r.moved_on.split('-').reverse().join('.'), key: `${r.type_code}-${r.device_id}`, dev: r.hostname || r.model || r.type_name, inv: r.inv_number || '',
      l0: g('Расположение', 0), l1: g('Расположение', 1), e0: g('Пользователь', 0), e1: g('Пользователь', 1),
      d0: g('Отдел', 0), d1: g('Отдел', 1), w0: g('Рабочее место', 0), w1: g('Рабочее место', 1), note: r.note, who: r.user_name || '',
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 14 } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="device-moves.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
