// Установленное ПО с компьютера (WMI, реестр Uninstall) → сравнение с карточкой → перенос отмеченного.
// Сбор идёт в фоне (на большом компьютере до минуты-двух), браузер опрашивает результат.
// Работает независимо от учёта лицензий (его администратор может скрыть) — ПО в карточке нужно всегда.
const express = require('express');
const { query, tx } = require('../db');
const { requireStaff } = require('../access');
const { HttpError, ah, str, intOrNull } = require('../util');
const PS = require('./powershell');
const NP = require('./index');

const router = express.Router();
const jobs = new Map(); // id техники → { started_at, finished_at, error, items }

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Дата установки из реестра: 20240115 → 2024-01-15 */
function regDate(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function current(deviceId) {
  const { rows } = await query(
    `SELECT ds.id, ds.version, s.id AS software_id, s.name, s.vendor
       FROM device_software ds JOIN software s ON s.id = ds.software_id WHERE ds.device_id = $1 ORDER BY s.name`, [deviceId]);
  return rows;
}

/** Сравнение найденного на компьютере с карточкой */
function compare(found, cur) {
  const byName = new Map(cur.map((c) => [norm(c.name), c]));
  const seen = new Set();
  const items = found.map((f) => {
    const c = byName.get(norm(f.name));
    if (c) seen.add(c.id);
    const state = !c ? 'new' : (f.version && norm(f.version) !== norm(c.version)) ? 'version' : 'same';
    return { ...f, installed: regDate(f.installed), state, card_id: c ? c.id : null, card_version: c ? c.version || '' : null };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const missing = cur.filter((c) => !seen.has(c.id)).map((c) => ({ card_id: c.id, name: c.name, version: c.version || '' }));
  return { items, missing };
}

router.post('/device/:id/software', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const { rows: [d] } = await query('SELECT id, hostname, ip_address FROM devices WHERE id = $1', [id]);
  if (!d) throw new HttpError(404, 'Техника не найдена');
  const target = (d.hostname || '').trim() || (d.ip_address || '').trim();
  if (!target) throw new HttpError(400, 'Укажите в карточке сетевое имя или IP-адрес компьютера');
  const j0 = jobs.get(id);
  if (j0 && !j0.finished_at) return res.status(202).json(j0);
  const s = await NP.loadSettings({ withPassword: true });
  if (!s.wmi_enabled) throw new HttpError(400, 'WMI выключен: Инвентарь → Настройки → «Сведения из сети»');
  const job = { started_at: new Date().toISOString(), finished_at: null, error: null, target, found: null };
  jobs.set(id, job);
  PS.softwareCollect(s, target)
    .then((r) => { if (r.error) job.error = NP.wmiError(r.error); else job.found = r.items || []; })
    .catch((e) => { job.error = e.message; })
    .finally(() => { job.finished_at = new Date().toISOString(); });
  res.status(202).json(job);
}));

router.get('/device/:id/software', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const job = jobs.get(id);
  if (!job) return res.json(null);
  const out = { started_at: job.started_at, finished_at: job.finished_at, error: job.error, target: job.target };
  if (job.found) Object.assign(out, compare(job.found, await current(id)));
  res.json(out);
}));

// Перенести отмеченное: add — новые программы, update — новая версия, remove — нет на компьютере
router.post('/device/:id/software/apply', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const add = (Array.isArray(b.add) ? b.add : []).slice(0, 2000);
  const upd = (Array.isArray(b.update) ? b.update : []).slice(0, 2000);
  const rem = (Array.isArray(b.remove) ? b.remove : []).map(Number).filter(Number.isInteger).slice(0, 2000);
  const n = await tx(async (db) => {
    const { rows: [d] } = await db.query('SELECT id FROM devices WHERE id = $1', [id]);
    if (!d) throw new HttpError(404, 'Техника не найдена');
    let added = 0;
    let updated = 0;
    let removed = 0;
    const names = [];
    for (const x of add) {
      const name = str(x.name, 300);
      if (!name) continue;
      const { rows: [sw] } = await db.query(
        `INSERT INTO software (name, vendor) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET vendor = COALESCE(software.vendor, EXCLUDED.vendor)
         RETURNING id`, [name, str(x.publisher, 300) || null]);
      const exists = await db.query('SELECT 1 FROM device_software WHERE device_id = $1 AND software_id = $2', [id, sw.id]);
      if (exists.rows[0]) continue;
      await db.query(`INSERT INTO device_software (device_id, software_id, version, installed_at, note) VALUES ($1, $2, $3, $4, $5)`,
        [id, sw.id, str(x.version, 100), regDate(x.installed) || (/^\d{4}-\d{2}-\d{2}$/.test(String(x.installed || '')) ? x.installed : null), 'с компьютера (WMI)']);
      added++; names.push(name);
    }
    for (const x of upd) {
      const r = await db.query('UPDATE device_software SET version = $1 WHERE id = $2 AND device_id = $3', [str(x.version, 100), intOrNull(x.card_id), id]);
      updated += r.rowCount;
    }
    if (rem.length) {
      const r = await db.query('DELETE FROM device_software WHERE device_id = $1 AND id = ANY($2::int[])', [id, rem]);
      removed = r.rowCount;
    }
    if (added || updated || removed) {
      const ch = {};
      if (added) ch['ПО добавлено с компьютера'] = [null, `${added}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`];
      if (updated) ch['Версий ПО обновлено'] = [null, String(updated)];
      if (removed) ch['ПО удалено (нет на компьютере)'] = [null, String(removed)];
      await db.query('INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, $3, $4)',
        [id, req.user.id, 'software_synced', JSON.stringify(ch)]);
      await db.query('UPDATE devices SET updated_at = now(), updated_by = $2 WHERE id = $1', [id, req.user.id]);
    }
    return { added, updated, removed };
  });
  res.json(n);
}));

module.exports = router;
