// Сканирование сети: поиск техники в подсетях, опознание и сравнение с базой инвентаря.
//
// 1. Поиск: TCP-порты (без процессов) и ping для остальных адресов; после — ARP-таблица сервера.
// 2. Опознание отвечающих адресов: DNS, NetBIOS (имя, домен, пользователь, MAC), SNMP (принтеры), по желанию — WMI.
// 3. Совпадения с базой считаются при каждом открытии страницы: MAC и серийный номер — надёжно,
//    сетевое имя — вероятно, IP — слабо. Результат последнего сканирования хранится в netscan_last.
const os = require('os');
const express = require('express');
const { query } = require('../db');
const { HttpError, ah, str } = require('../util');
const P = require('./probes');
const { wmiCollect } = require('./powershell');
const NP = require('./index');

const router = express.Router();
const MAX_HOSTS = 4096;

// ---------------- Диапазоны адресов ----------------
const ipToInt = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** «10.0.1.0/24, 10.0.2.10-10.0.2.50, 10.0.3.7» → [[начало, конец], …] */
function parseNetworks(text) {
  const ranges = [];
  for (const part of String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    let m;
    if ((m = part.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/)) && P.isIPv4(m[1])) {
      const bits = Number(m[2]);
      if (bits < 16 || bits > 32) throw new HttpError(400, `Сеть ${part}: маска от /16 до /32`);
      const size = 2 ** (32 - bits);
      const base = Math.floor(ipToInt(m[1]) / size) * size;
      ranges.push(bits >= 31 ? [base, base + size - 1] : [base + 1, base + size - 2]); // без адреса сети и широковещательного
    } else if ((m = part.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+|\d{1,3})$/)) && P.isIPv4(m[1])) {
      const a = ipToInt(m[1]);
      const b = m[2].includes('.') ? ipToInt(m[2]) : Math.floor(a / 256) * 256 + Number(m[2]);
      if (!(b >= a)) throw new HttpError(400, `Диапазон ${part}: конец раньше начала`);
      ranges.push([a, b]);
    } else if (P.isIPv4(part)) {
      ranges.push([ipToInt(part), ipToInt(part)]);
    } else {
      throw new HttpError(400, `Не понимаю «${part}». Примеры: 10.0.1.0/24, 10.0.1.10-10.0.1.50, 10.0.1.7`);
    }
  }
  const total = ranges.reduce((a, [s, e]) => a + e - s + 1, 0);
  if (!total) throw new HttpError(400, 'Укажите сети для сканирования');
  if (total > MAX_HOSTS) throw new HttpError(400, `Слишком много адресов (${total}). За раз — не больше ${MAX_HOSTS} (например, 16 сетей /24)`);
  return ranges;
}

/** Сети сервера (если в настройках не указаны): подсети его сетевых карт, но не шире /24 */
function localNetworks() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address)) continue;
      const bits = Math.max(24, (a.netmask || '255.255.255.0').split('.').reduce((n, o) => n + (Number(o).toString(2).match(/1/g) || []).length, 0));
      const base = intToIp(Math.floor(ipToInt(a.address) / 2 ** (32 - bits)) * 2 ** (32 - bits));
      out.push(`${base}/${bits}`);
    }
  }
  return [...new Set(out)].join(', ');
}

// ---------------- Сканирование ----------------
let job = null; // { started_at, phase, done, total, found, by, networks, error, finished_at }

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

/** ARP-таблица сервера: ip → MAC */
async function arpTable() {
  const r = P.IS_WIN ? await P.runFile('arp', ['-a'], { timeout: 8000 }) : await P.runFile('ip', ['neigh'], { timeout: 8000 });
  const map = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const ip = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    const mac = line.match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i);
    if (!ip || !mac) continue;
    const m = mac[0].replace(/[-:]/g, '').toUpperCase();
    if (m === 'FFFFFFFFFFFF' || m === '000000000000' || /^01005E/.test(m)) continue; // широковещательные и групповые
    map.set(ip[1], m.match(/../g).join(':'));
  }
  return map;
}

function guessKind(h) {
  const ports = new Set(h.ports.map((p) => p.port));
  const w = h.wmi;
  if (w) {
    if (/server/i.test(w.os || '')) return 'server';
    if (String(w.chassis || '').split(',').some((c) => ['8', '9', '10', '14', '30', '31', '32'].includes(c.trim()))) return 'notebook';
    return 'computer';
  }
  if (h.snmp && (h.snmp.page_count != null || h.snmp.supplies?.length || /print|laserjet|mfp|ecosys|i-sensys|kyocera|canon|xerox|ricoh|brother|epson|pantum/i.test(`${h.snmp.model} ${h.snmp.description}`))) return 'printer';
  if (ports.has(9100) || ports.has(515) || ports.has(631)) return 'printer';
  if (ports.has(135) || ports.has(445) || ports.has(3389) || ports.has(5985)) return 'computer';
  if (h.snmp) return 'network';
  return 'unknown';
}

async function runScan(networks, ranges, { wmi }, userId) {
  const ips = [];
  for (const [s, e] of ranges) for (let n = s; n <= e; n++) ips.push(intToIp(n));
  const s = await NP.loadSettings({ withPassword: true });
  const set = (phase, done, total) => Object.assign(job, { phase, done, total });

  // 1. Поиск отвечающих адресов: сначала порты, у остальных — ping
  const alive = new Map(); // ip → { ports, ping }
  set('Поиск устройств: проверка портов', 0, ips.length);
  await pool(ips, 96, async (ip) => {
    const ports = await P.scanPorts(ip);
    if (ports.length) alive.set(ip, { ports, ping: null });
    job.done++; job.found = alive.size;
  });
  const rest = ips.filter((ip) => !alive.has(ip));
  set('Поиск устройств: ping', 0, rest.length);
  await pool(rest, 24, async (ip) => {
    const pg = await P.ping(ip);
    if (pg.alive) alive.set(ip, { ports: [], ping: pg.ms });
    job.done++; job.found = alive.size;
  });
  // Адреса из ARP-таблицы (отвечают в сети, хотя не открыли порты и не ответили на ping)
  const arp = await arpTable();
  const inRange = (ip) => { const n = ipToInt(ip); return ranges.some(([a, b]) => n >= a && n <= b); };
  for (const ip of arp.keys()) if (inRange(ip) && !alive.has(ip)) alive.set(ip, { ports: [], ping: null, arpOnly: true });

  // 2. Опознание
  const list = [...alive.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  const hosts = [];
  set('Опознание устройств: имена, NetBIOS, SNMP', 0, list.length);
  const dns = require('dns').promises;
  await pool(list, 32, async (ip) => {
    const a = alive.get(ip);
    const [names, nb, sn] = await Promise.all([
      Promise.race([dns.reverse(ip).catch(() => []), new Promise((r) => setTimeout(() => r([]), 3000))]),
      P.netbios(ip),
      s.snmp_enabled ? P.snmp(ip, NP.communities(s)) : null,
    ]);
    hosts.push({
      ip, ports: a.ports, ping: a.ping, arp_only: !!a.arpOnly,
      dns_name: names[0] || '', netbios: nb || null, mac: arp.get(ip) || nb?.mac || '', snmp: sn || null,
    });
    job.done++;
  });
  for (const h of hosts) h.kind = guessKind(h);

  // 3. WMI — по желанию, только Windows-компьютеры с открытыми портами WMI/WinRM
  if (wmi && s.wmi_enabled) {
    const targets = hosts.filter((h) => h.ports.some((p) => p.port === 135 || p.port === 5985));
    set('Характеристики компьютеров (WMI)', 0, targets.length);
    await pool(targets, 4, async (h) => {
      const name = h.netbios?.computer || (h.dns_name ? h.dns_name.split('.')[0] : '') || h.ip;
      const r = await wmiCollect(s, name);
      if (r.error) h.wmi_error = NP.wmiError(r.error);
      else { h.wmi = NP.normalizeWmi(r); h.kind = guessKind(h); }
      job.done++;
    });
  }

  hosts.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  await query(
    `INSERT INTO netscan_last (id, started_at, finished_at, networks, ranges, hosts, scanned_by)
     VALUES (1, $1, now(), $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = now(), networks = EXCLUDED.networks,
       ranges = EXCLUDED.ranges, hosts = EXCLUDED.hosts, scanned_by = EXCLUDED.scanned_by`,
    [job.started_at, networks, JSON.stringify(ranges), JSON.stringify(hosts), userId]);
  job.fresh = await updatePending(hosts);
}

// ---------------- «Ждут решения» ----------------
const hostKey = (h) => (normMac(h.mac) ? `mac:${normMac(h.mac)}` : `ip:${h.ip}`);
// Подпись состояния: новое устройство или какие поля и как отличаются — чтобы понять, изменилось ли что-то с момента решения
const sigOf = (m) => (m.status === 'new' ? 'new' : m.status === 'diff' ? 'diff:' + m.diff.map((f) => `${f}=${m.suggest[f]}`).sort().join('|') : m.status);

async function matchContext() {
  const [devices, ign, fopts] = await Promise.all([loadDevices(), query('SELECT key FROM netscan_ignore'), NP.loadFormatOpts()]);
  return { devices, ignored: new Set(ign.rows.map((r) => r.key)), fopts };
}

/** После сканирования: новые и отличающиеся — в «Ждут решения»; ставшие совпадающими — снимаются */
/** Возвращает новую технику, которая только что попала в «Ждут решения» */
async function updatePending(hosts) {
  const ctx = await matchContext();
  const { hosts: matched } = matchAll(hosts, ctx.devices, ctx.ignored, [], ctx.fopts);
  const was = new Set((await query(`SELECT key FROM netscan_hosts WHERE state = 'pending'`)).rows.map((r) => r.key));
  const fresh = [];
  // Найденная в сети техника из базы — отметка «была в сети» (уведомление «давно не в сети»)
  await NP.markSeen(matched.filter((m) => m.device).map((m) => m.device.id));
  for (const m of matched) {
    const key = hostKey(m);
    const sig = sigOf(m);
    const raw = hosts.find((x) => x.ip === m.ip);
    if (m.status === 'new' || m.status === 'diff') {
      await query(
        `INSERT INTO netscan_hosts (key, host, state) VALUES ($1, $2, 'pending')
         ON CONFLICT (key) DO UPDATE SET host = EXCLUDED.host, last_seen = now(),
           state = CASE WHEN netscan_hosts.state = 'done' AND netscan_hosts.handled_sig = $3 THEN 'done' ELSE 'pending' END`,
        [key, JSON.stringify(raw), sig]);
      if (m.status === 'new' && !was.has(key)) {
        const { rows } = await query(`SELECT state FROM netscan_hosts WHERE key = $1`, [key]);
        if (rows[0] && rows[0].state === 'pending') fresh.push(m);
      }
    } else {
      await query(`UPDATE netscan_hosts SET host = $2, last_seen = now(),
                     state = CASE WHEN state = 'pending' THEN 'done' ELSE state END,
                     handled_action = CASE WHEN state = 'pending' THEN 'auto' ELSE handled_action END,
                     handled_at = CASE WHEN state = 'pending' THEN now() ELSE handled_at END
                   WHERE key = $1`, [key, JSON.stringify(raw)]);
    }
  }
  return fresh;
}


// ---------------- Совпадения с базой ----------------
const normMac = (m) => { const x = String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase(); return x.length === 12 ? x : ''; };
const shortHost = (n) => String(n || '').trim().toLowerCase().split('.')[0];
const BAD_SERIAL = /^(to be filled.*|default string|system serial number|none|n\/a|0+|1234567890|chassis serial number)$/i;
const normSerial = (s) => { const x = String(s || '').trim().toLowerCase(); return x.length >= 4 && !BAD_SERIAL.test(x) ? x : ''; };
const normText = (v) => String(v ?? '').toLowerCase().replace(/[\s()®™]+/g, ' ').trim();
const FIELDS = ['hostname', 'model', 'serial_number', 'cpu', 'ram', 'storage', 'os', 'ip_address', 'mac_address'];

/** Что известно об устройстве из сканирования — в виде полей карточки (как в «Сведениях из сети») */
function hostSuggest(h, fopts) {
  const sections = {
    network: { state: 'done', data: { used_ip: h.ip, mac: h.mac } },
    wmi: h.wmi ? { state: 'done', data: h.wmi } : { state: 'off' },
    snmp: h.snmp ? { state: 'done', data: h.snmp } : { state: 'off' },
  };
  const out = NP.suggestions(sections, fopts);
  if (!out.hostname) {
    const name = h.netbios?.computer || (h.dns_name ? h.dns_name.split('.')[0].toUpperCase() : '') || h.snmp?.name || '';
    if (name) out.hostname = name;
  }
  return out;
}

async function loadDevices() {
  const { rows } = await query(
    `SELECT d.id, t.id AS type_id, t.code AS type_code, t.name AS type_name, t.color AS type_color, d.status,
            d.hostname, d.ip_address, d.mac_address, d.serial_number, d.inv_number,
            lm.value AS model, lc.value AS cpu, lr.value AS ram, ls.value AS storage, lo.value AS os, le.value AS employee
       FROM devices d JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups lc ON lc.id = d.cpu_id
       LEFT JOIN lookups lr ON lr.id = d.ram_id LEFT JOIN lookups ls ON ls.id = d.storage_id
       LEFT JOIN lookups lo ON lo.id = d.os_id LEFT JOIN lookups le ON le.id = d.employee_id`);
  return rows;
}

function matchAll(hosts, devices, ignored, ranges, fopts) {
  const by = { mac: new Map(), serial: new Map(), host: new Map(), ip: new Map() };
  const add = (m, k, d) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(d); };
  for (const d of devices) {
    add(by.mac, normMac(d.mac_address), d);
    add(by.serial, normSerial(d.serial_number), d);
    add(by.host, shortHost(d.hostname), d);
    add(by.ip, String(d.ip_address || '').trim(), d);
  }
  const used = new Set();
  const out = hosts.map((h) => {
    const sug = hostSuggest(h, fopts);
    const tries = [
      ['mac', 'MAC-адрес', by.mac.get(normMac(h.mac))],
      ['serial', 'серийный номер', by.serial.get(normSerial(sug.serial_number))],
      ['host', 'сетевое имя', by.host.get(shortHost(sug.hostname))],
      ['ip', 'IP-адрес', by.ip.get(h.ip)],
    ];
    let match = null; let reason = []; let conflict = null;
    for (const [k, label, list] of tries) {
      if (!list?.length) continue;
      if (!match) {
        if (list.length > 1 && k !== 'ip') conflict = list.map((d) => ({ id: d.id, key: `${d.type_code}-${d.id}`, hostname: d.hostname }));
        match = list[0];
        reason.push(label);
      } else if (list.some((d) => d.id === match.id)) reason.push(label);
    }
    const strength = !match ? null : reason.includes('MAC-адрес') || reason.includes('серийный номер') ? 'strong' : reason.includes('сетевое имя') ? 'name' : 'ip';
    let diff = [];
    if (match) {
      used.add(match.id);
      diff = FIELDS.filter((f) => sug[f] && normText(sug[f]) !== normText(f === 'mac_address' ? (normMac(match[f]) ? normMac(match[f]).match(/../g).join(':') : match[f]) : match[f]));
    }
    const key = hostKey(h);
    const isIgnored = ignored.has(key) || ignored.has(`ip:${h.ip}`);
    const status = isIgnored ? 'ignored' : !match ? 'new' : diff.length ? 'diff' : 'match';
    return {
      ...h, suggest: sug, ignore_key: key, status, strength, reason, conflict, diff,
      device: match ? { id: match.id, key: `${match.type_code}-${match.id}`, type_id: match.type_id, type_name: match.type_name,
        type_color: match.type_color, hostname: match.hostname, ip_address: match.ip_address, model: match.model, employee: match.employee } : null,
    };
  });
  // Техника из базы с IP в просканированных сетях, которая не ответила
  const inRange = (ip) => { if (!P.isIPv4(ip)) return false; const n = ipToInt(ip); return ranges.some(([a, b]) => n >= a && n <= b); };
  const missing = devices.filter((d) => !used.has(d.id) && inRange(String(d.ip_address || '').trim()) && d.status !== 'written_off')
    .map((d) => ({ id: d.id, key: `${d.type_code}-${d.id}`, type_name: d.type_name, type_color: d.type_color, hostname: d.hostname, ip_address: d.ip_address, model: d.model, employee: d.employee }));
  return { hosts: out, missing };
}

// ---------------- API ----------------
router.get('/', ah(async (req, res) => {
  const s = await NP.loadSettings();
  const [{ rows: [last] }, { rows: ign }] = await Promise.all([
    query(`SELECT l.started_at, l.finished_at, l.networks, l.ranges, l.hosts,
                  CASE WHEN l.scanned_by IS NULL THEN 'по расписанию' WHEN u.role = 'superadmin' THEN 'Служба ИТ'
                       ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS scanned_by
             FROM netscan_last l LEFT JOIN users u ON u.id = l.scanned_by WHERE l.id = 1`),
    query('SELECT key FROM netscan_ignore'),
  ]);
  const ctx = await matchContext();
  let result = null;
  if (last) {
    const m = matchAll(last.hosts, ctx.devices, ctx.ignored, last.ranges, ctx.fopts);
    result = { started_at: last.started_at, finished_at: last.finished_at, networks: last.networks, scanned_by: last.scanned_by, ...m };
  }
  // Ждут решения: сохранённые сведения сравниваются с базой заново; то, что уже совпадает или скрыто, снимается
  const { rows: pend } = await query(`SELECT key, host, first_seen, last_seen FROM netscan_hosts WHERE state = 'pending' ORDER BY first_seen, key`);
  const pm = matchAll(pend.map((r) => r.host), ctx.devices, ctx.ignored, [], ctx.fopts).hosts;
  const pending = [];
  for (let i = 0; i < pm.length; i++) {
    const m = pm[i];
    if (m.status === 'new' || m.status === 'diff') pending.push({ ...m, first_seen: pend[i].first_seen, last_seen: pend[i].last_seen });
    else {
      await query(`UPDATE netscan_hosts SET state = 'done', handled_action = $2, handled_at = now(), handled_sig = $3 WHERE key = $1`,
        [pend[i].key, m.status === 'ignored' ? 'ignored' : 'auto', sigOf(m)]);
    }
  }
  res.json({
    defaults: { networks: s.scan_networks || localNetworks(), from_settings: !!s.scan_networks, wmi_enabled: s.wmi_enabled, has_account: !!s.username },
    job: job ? { ...job, fresh: undefined } : null,
    result,
    pending,
    schedule: { ...SCHEDULE_DEF, ...(s.scan_schedule || {}), last_auto: s.scan_last_auto || null },
  });
}));

/** Запустить сканирование в фоне; userId = null — по расписанию */
function startScan(networks, wmi, userId) {
  if (job && !job.finished_at) throw new HttpError(409, 'Сканирование уже идёт');
  const ranges = parseNetworks(networks);
  job = { started_at: new Date().toISOString(), phase: 'Подготовка', done: 0, total: 0, found: 0, networks, error: null, finished_at: null, auto: !userId };
  const j = job;
  const p = runScan(networks, ranges, { wmi: !!wmi }, userId)
    .catch((e) => { j.error = e.message; console.error('Сканирование сети:', e); })
    .finally(() => { j.finished_at = new Date().toISOString(); });
  return { job: j, done: p };
}

router.post('/', ah(async (req, res) => {
  const networks = (str(req.body.networks, 1000) || '').trim();
  const { job: j } = startScan(networks, !!req.body.wmi, req.user.id);
  res.status(202).json({ job: { ...j, fresh: undefined } });
}));

// ---------------- Сканирование по расписанию ----------------
// netprobe_settings.scan_schedule: { mode: off | daily | weekly, time: 'ЧЧ:ММ', weekday: 1–7 (пн–вс), wmi }
const SCHEDULE_DEF = { mode: 'off', time: '01:00', weekday: 1, wmi: false };

router.put('/schedule', ah(async (req, res) => {
  const b = req.body || {};
  const v = {
    mode: ['off', 'daily', 'weekly'].includes(b.mode) ? b.mode : 'off',
    time: /^\d{1,2}:\d{2}$/.test(String(b.time || '')) ? String(b.time).padStart(5, '0') : SCHEDULE_DEF.time,
    weekday: Math.min(7, Math.max(1, Number(b.weekday) || 1)),
    wmi: !!b.wmi,
  };
  await query(`INSERT INTO netprobe_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await query('UPDATE netprobe_settings SET scan_schedule = $1 WHERE id = 1', [JSON.stringify(v)]);
  await require('../../portal/audit').log(req, 'netscan_schedule', null, v);
  res.json(v);
}));

let lastAutoDay = null;
async function scheduleTick() {
  const s = await NP.loadSettings();
  const sch = { ...SCHEDULE_DEF, ...(s.scan_schedule || {}) };
  if (sch.mode === 'off' || (job && !job.finished_at)) return;
  const now = new Date();
  const wd = now.getDay() || 7;
  if (sch.mode === 'weekly' && wd !== sch.weekday) return;
  const [hh, mm] = sch.time.split(':').map(Number);
  const due = new Date(now); due.setHours(hh || 0, mm || 0, 0, 0);
  if (now < due) return;
  const today = now.toDateString();
  const last = s.scan_last_auto ? new Date(s.scan_last_auto) : null;
  if (lastAutoDay === today || (last && last.toDateString() === today && last >= due)) return;
  lastAutoDay = today;
  await query('UPDATE netprobe_settings SET scan_last_auto = now() WHERE id = 1');
  const networks = (s.scan_networks || localNetworks()).trim();
  if (!networks) return;
  const { job: j, done } = startScan(networks, sch.wmi && s.wmi_enabled, null);
  await require('../../portal/health').track('netscan_auto', async () => {
    await done;
    if (j.error) throw new Error(j.error);
    return `найдено устройств: ${j.found ?? '—'}, новых: ${(j.fresh || []).length}`;
  }).catch(() => {});
  if (j.error) {
    console.error('Сканирование по расписанию:', j.error);
    return;
  }
  const fresh = j.fresh || [];
  if (fresh.length) {
    const N = require('../../portal/notify');
    const names = fresh.slice(0, 10).map((m) => [m.ip, m.hostname || m.netbios_name || m.vendor || ''].filter(Boolean).join(' ')).join('\n');
    await N.emit(await N.usersWhere((u) => u.role === 'superadmin' || (u.modules && u.modules.inventory === 'edit')), 'netscan_new', {
      title: `Сканирование сети: найдено новой техники — ${fresh.length}`,
      body: names + (fresh.length > 10 ? `\n… и ещё ${fresh.length - 10}` : ''),
      link: '/inventory/#/netscan',
    });
  }
}

function startSchedule() {
  require('../../portal/health').register('netscan_auto', 'Сканирование сети по расписанию', null);
  const run = () => scheduleTick().catch((e) => console.error('Сканирование по расписанию:', e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 60 * 1000).unref?.();
}

// Отметить решённым: добавлено, дополнено или «оставить как есть». Вернётся, только если изменятся отличия
router.post('/handled', ah(async (req, res) => {
  const key = String(req.body.key || '');
  const action = ['added', 'updated', 'skipped'].includes(req.body.action) ? req.body.action : 'skipped';
  const { rows } = await query('SELECT host FROM netscan_hosts WHERE key = $1', [key]);
  if (!rows[0]) return res.json({ ok: true }); // устройства нет в списке (например, из последнего сканирования до обновления)
  const ctx = await matchContext();
  const [m] = matchAll([rows[0].host], ctx.devices, ctx.ignored, [], ctx.fopts).hosts;
  await query(`UPDATE netscan_hosts SET state = 'done', handled_sig = $2, handled_action = $3, handled_by = $4, handled_at = now() WHERE key = $1`,
    [key, sigOf(m), action, req.user.id]);
  res.json({ ok: true });
}));

// Скрыть / вернуть устройство в списке
router.post('/ignore', ah(async (req, res) => {
  const key = String(req.body.key || '');
  if (!/^(mac:[0-9A-F]{12}|ip:\d+\.\d+\.\d+\.\d+)$/.test(key)) throw new HttpError(400, 'Неверный ключ');
  if (req.body.ignore === false) await query('DELETE FROM netscan_ignore WHERE key = $1', [key]);
  else {
    await query(`INSERT INTO netscan_ignore (key, note, created_by) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET note = EXCLUDED.note`, [key, str(req.body.note, 300) || '', req.user.id]);
  }
  res.json({ ok: true });
}));

module.exports = router;
module.exports.parseNetworks = parseNetworks;
module.exports.startSchedule = startSchedule;
