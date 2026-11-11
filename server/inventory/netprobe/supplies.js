// Расходники принтеров и МФУ: опрос по SNMP по расписанию и уведомления о скорой замене.
// Опрашивается вся техника типов «Принтер» / «МФУ» с IP-адресом (кроме списанной).
const { query } = require('../db');
const P = require('./probes');
const NP = require('./index');

const EVERY_MS = 2 * 3600 * 1000;   // раз в 2 часа
const FIRST_MS = 60 * 1000;         // первый опрос — через минуту после запуска
let running = null;

const PRINTER_SQL = `(upper(t.code) IN ('PRN', 'MFU') OR t.name ~* '(принтер|мфу|плоттер)') AND d.status <> 'written_off'`;

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Опросить все принтеры и МФУ */
async function pollAll() {
  if (running) return running;
  running = (async () => {
    const s = await NP.loadSettings();
    if (!s.snmp_enabled) return { polled: 0 };
    const { rows } = await query(
      `SELECT d.id, d.ip_address FROM devices d JOIN device_types t ON t.id = d.type_id
        WHERE ${PRINTER_SQL} AND d.ip_address IS NOT NULL AND d.ip_address <> ''`);
    const list = rows.filter((r) => P.isIPv4(String(r.ip_address).trim()));
    await pool(list, 8, async (d) => {
      const r = await P.snmp(String(d.ip_address).trim(), NP.communities(s));
      await query(
        `INSERT INTO printer_supplies (device_id, supplies, model, error, checked_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (device_id) DO UPDATE SET
           supplies = CASE WHEN EXCLUDED.error IS NULL THEN EXCLUDED.supplies ELSE printer_supplies.supplies END,
           model = COALESCE(EXCLUDED.model, printer_supplies.model), error = EXCLUDED.error, checked_at = now()`,
        [d.id, JSON.stringify(r?.supplies || []), r?.model || null, r ? null : 'Не ответил по SNMP']);
      if (r) await query(`INSERT INTO device_seen (device_id, last_seen) VALUES ($1, now())
                          ON CONFLICT (device_id) DO UPDATE SET last_seen = now()`, [d.id]);
    });
    return { polled: list.length };
  })().finally(() => { running = null; });
  return running;
}

function start() {
  const run = () => pollAll().catch((e) => console.error('Расходники принтеров:', e.message));
  setTimeout(run, FIRST_MS).unref?.();
  setInterval(run, EVERY_MS).unref?.();
}

/**
 * Уведомления о расходниках для пользователя: техника, которую он видит в инвентаре (типы/отделы),
 * расходники с остатком не больше порога. P — права пользователя в инвентаре (access.perms).
 */
async function supplyAlerts(P) {
  const s = await NP.loadSettings();
  const threshold = Number.isFinite(s.supply_threshold) ? s.supply_threshold : 15;
  const where = [PRINTER_SQL];
  const vals = [];
  if (P.types !== null) { vals.push(P.types); where.push(`d.type_id = ANY($${vals.length}::int[])`); }
  if (P.departments !== null) { vals.push(P.departments); where.push(`d.department_id = ANY($${vals.length}::int[])`); }
  const { rows } = await query(
    `SELECT d.id, t.code AS type_code, t.name AS type_name, d.hostname, d.ip_address, ps.supplies, ps.model AS snmp_model,
            ps.checked_at, lm.value AS model, ll.value AS location, ld.value AS department
       FROM printer_supplies ps
       JOIN devices d ON d.id = ps.device_id JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups ll ON ll.id = d.location_id LEFT JOIN lookups ld ON ld.id = d.department_id
      WHERE ${where.join(' AND ')}`, vals);
  const items = [];
  for (const r of rows) {
    for (const x of r.supplies || []) {
      if (x.percent == null || x.percent > threshold) continue;
      items.push({
        kind: 'supply', device_id: r.id, key: `${r.type_code}-${r.id}`, type_name: r.type_name,
        title: r.hostname || r.model || r.snmp_model || `${r.type_name} ${r.type_code}-${r.id}`,
        model: r.model || r.snmp_model || '', location: r.location || '', department: r.department || '', ip: r.ip_address,
        supply: x.name, percent: x.percent, level: x.percent <= 5 ? 'critical' : 'warning', checked_at: r.checked_at,
      });
    }
  }
  items.sort((a, b) => a.percent - b.percent || a.title.localeCompare(b.title, 'ru'));
  return { threshold, items };
}

async function threshold() {
  const s = await NP.loadSettings();
  return Number.isFinite(s.supply_threshold) ? s.supply_threshold : 15;
}

module.exports = { start, pollAll, supplyAlerts, threshold };
