// Учёт лицензий ПО: сколько куплено и сколько установок найдено в карточках техники.
// Установки считаются по справочнику ПО: выбранная программа и (необязательно) все программы, в названии
// которых есть «Шаблон» — например, «Microsoft Office» для разных версий. Списанная техника не считается.
// Администратор портала может скрыть учёт лицензий ото всех (portal_settings.inventory_features.licenses = false);
// сбор ПО с компьютеров при этом продолжает работать.
const express = require('express');
const { query } = require('../db');
const { requireStaff, requireSuperadmin } = require('../access');
const { HttpError, ah, str, intOrNull } = require('../util');
const { sendXlsx } = require('../../portal/xlsx');

const router = express.Router();
const KINDS = { device: 'на компьютер', user: 'на пользователя', site: 'на организацию (без ограничения)', subscription: 'подписка' };

async function features() {
  const { rows } = await query(`SELECT value FROM portal_settings WHERE key = 'inventory_features'`);
  return { licenses: true, ...((rows[0] && rows[0].value) || {}) };
}

// Выключатель — только администратор портала; виден ему всегда
router.get('/feature', ah(async (req, res) => res.json(await features())));
router.put('/feature', requireSuperadmin, ah(async (req, res) => {
  const v = { ...(await features()), licenses: !!(req.body || {}).licenses };
  await query(`INSERT INTO portal_settings (key, value) VALUES ('inventory_features', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(v)]);
  await require('../../portal/audit').log(req, 'inventory_features', null, v);
  res.json(v);
}));

// Остальное — только если учёт включён и пользователю видно ПО
router.use(ah(async (req, res, next) => {
  if (!(await features()).licenses) throw new HttpError(404, 'Учёт лицензий выключен администратором портала');
  if (!req.perms.software) throw new HttpError(403, 'Нет доступа к сведениям о ПО');
  next();
}));

// Совпадение программы с лицензией: сама программа или «шаблон» в названии
const MATCH = `(s.id = l.software_id OR (l.match <> '' AND lower(s.name) LIKE '%' || lower(l.match) || '%'))`;
const LIST_SQL = `
  SELECT l.*, sw.name AS software_name,
         (SELECT count(DISTINCT ds.device_id)::int FROM device_software ds JOIN software s ON s.id = ds.software_id
            JOIN devices d ON d.id = ds.device_id WHERE ${MATCH} AND d.status <> 'written_off') AS used
    FROM software_licenses l LEFT JOIN software sw ON sw.id = l.software_id`;

const withState = (r) => ({
  ...r,
  free: r.kind === 'site' ? null : r.qty - r.used,
  expired: r.expires ? new Date(r.expires) < new Date(new Date().toDateString()) : false,
});

router.get('/', ah(async (req, res) => {
  const { rows } = await query(`${LIST_SQL} ORDER BY COALESCE(sw.name, l.title)`);
  const staff = ['superadmin', 'editor'].includes(req.user.role);
  // Ключи лицензий — только тем, кто может менять инвентарь
  res.json({ items: rows.map(withState).map((r) => (staff ? r : { ...r, license_key: r.license_key ? '•••' : '' })), kinds: KINDS });
}));

router.get('/:id/devices', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT d.id, d.hostname, t.code AS type_code, t.name AS type_name, t.color AS type_color, s.name AS software, ds.version,
            le.value AS employee, ll.value AS location
       FROM software_licenses l JOIN software s ON ${MATCH}
       JOIN device_software ds ON ds.software_id = s.id JOIN devices d ON d.id = ds.device_id JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups le ON le.id = d.employee_id LEFT JOIN lookups ll ON ll.id = d.location_id
      WHERE l.id = $1 AND d.status <> 'written_off' ORDER BY d.hostname`, [intOrNull(req.params.id)]);
  res.json(rows);
}));

function body(b) {
  const softwareId = intOrNull(b.software_id);
  const match = str(b.match, 200) || '';
  const title = str(b.title, 300) || '';
  if (!softwareId && !match) throw new HttpError(400, 'Выберите программу или укажите шаблон названия');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  return [softwareId, match, title, Math.max(0, Math.min(1000000, Number(b.qty) || 0)), KINDS[b.kind] ? b.kind : 'device',
    day(b.purchased), day(b.expires), str(b.contract, 300) || '', str(b.license_key, 2000) || '', str(b.note, 2000) || ''];
}

router.post('/', requireStaff, ah(async (req, res) => {
  const { rows } = await query(
    `INSERT INTO software_licenses (software_id, match, title, qty, kind, purchased, expires, contract, license_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, body(req.body || {}));
  res.status(201).json(rows[0]);
}));

router.put('/:id', requireStaff, ah(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE software_licenses SET software_id=$1, match=$2, title=$3, qty=$4, kind=$5, purchased=$6, expires=$7, contract=$8,
            license_key=$9, note=$10 WHERE id=$11`, [...body(req.body || {}), intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Лицензия не найдена');
  res.json({ ok: true });
}));

router.delete('/:id', requireStaff, ah(async (req, res) => {
  await query('DELETE FROM software_licenses WHERE id = $1', [intOrNull(req.params.id)]);
  res.json({ ok: true });
}));

router.get('/export.xlsx', ah(async (req, res) => {
  const { rows } = await query(`${LIST_SQL} ORDER BY COALESCE(sw.name, l.title)`);
  await sendXlsx(res, 'licenses.xlsx', 'Лицензии', [
    { header: 'Программа', key: 'name', width: 40, get: (r) => r.title || r.software_name || r.match },
    { header: 'Шаблон', key: 'match', width: 20 },
    { header: 'Вид', key: 'kind', width: 22, get: (r) => KINDS[r.kind] || r.kind },
    { header: 'Куплено', key: 'qty', width: 10 },
    { header: 'Установлено', key: 'used', width: 12 },
    { header: 'Свободно', key: 'free', width: 10, get: (r) => (r.kind === 'site' ? '' : r.qty - r.used) },
    { header: 'Куплена', key: 'purchased', width: 12, date: 'day' },
    { header: 'Действует до', key: 'expires', width: 12, date: 'day' },
    { header: 'Договор', key: 'contract', width: 24 },
    { header: 'Примечание', key: 'note', width: 30 },
  ], rows);
}));

module.exports = router;
module.exports.features = features;
