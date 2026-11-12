// «Сведения из сети» для техники: сетевые проверки, Active Directory, WMI, SNMP.
// Опрос идёт в фоне (WMI может отвечать до двух минут): браузер запускает его и раз в пару секунд
// спрашивает, что готово. Результат сохраняется в device_netinfo — окно открывается сразу с прошлыми данными.
const express = require('express');
const { query } = require('../db');
const { requireStaff, requireSuperadmin } = require('../access');
const { HttpError, ah, intOrNull, str } = require('../util');
const { encrypt, decrypt } = require('../crypto');
const P = require('./probes');
const { adLookup, wmiCollect } = require('./powershell');
const F = require('./format');
const Remote = require('./remote');

const router = express.Router();
const MAX_JOBS = 4;
const jobs = new Map(); // ключ — id устройства или «test:<имя>»

// ---------------- Настройки ----------------
async function loadSettings({ withPassword = false } = {}) {
  const { rows } = await query('SELECT * FROM netprobe_settings WHERE id = 1');
  const s = rows[0] || { ad_enabled: true, wmi_enabled: true, snmp_enabled: true, ad_server: '', ad_base_dn: '', username: '', password_enc: null, snmp_communities: 'public' };
  const out = {
    ad_enabled: s.ad_enabled, wmi_enabled: s.wmi_enabled, snmp_enabled: s.snmp_enabled,
    ad_server: s.ad_server, ad_base_dn: s.ad_base_dn, username: s.username, has_password: !!s.password_enc,
    snmp_communities: s.snmp_communities, scan_networks: s.scan_networks || '', updated_at: s.updated_at || null,
    scan_schedule: s.scan_schedule || { mode: 'off' }, scan_last_auto: s.scan_last_auto || null,
    remote_connect: Remote.settingsOf(s),
    supply_threshold: s.supply_threshold ?? 15,
  };
  if (withPassword) {
    try { out.password = s.password_enc ? decrypt(s.password_enc) : ''; } catch { out.password = ''; out.password_error = true; }
  }
  return out;
}
const communities = (s) => s.snmp_communities.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5);

router.get('/settings', requireSuperadmin, ah(async (req, res) => {
  res.json({ settings: await loadSettings(), platform: P.IS_WIN || process.env.NETPROBE_FAKE_DIR ? 'windows' : process.platform });
}));

router.put('/settings', requireSuperadmin, require('../../portal/audit').trackChanges([[/^\/settings$/, 'netprobe_settings']]), ah(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username, 200) || '';
  if (username && !/^[^\s"]+$/.test(username)) throw new HttpError(400, 'Логин без пробелов и кавычек, например CORP\\ivanov или ivanov@corp.local');
  const server = str(b.ad_server, 200) || '';
  if (server && !/^[A-Za-z0-9_.:-]+$/.test(server)) throw new HttpError(400, 'Адрес контроллера домена: имя или IP, например dc01.corp.local');
  const base = str(b.ad_base_dn, 500) || '';
  const comm = (str(b.snmp_communities, 200) || 'public').trim();
  const nets = (str(b.scan_networks, 1000) || '').trim();
  const thr = Math.max(1, Math.min(90, Math.round(Number(b.supply_threshold) || 15)));
  const vals = [!!b.ad_enabled, !!b.wmi_enabled, !!b.snmp_enabled, server, base, username, comm, req.user.id, nets, thr];
  // Пароль: не прислан — не меняется; пустая строка с clear_password — удалить
  let pw = '';
  if (typeof b.password === 'string' && b.password !== '') { vals.push(encrypt(b.password)); pw = `, password_enc = $${vals.length}`; }
  else if (b.clear_password || !username) pw = ', password_enc = NULL';
  await query(`INSERT INTO netprobe_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await query(
    `UPDATE netprobe_settings SET ad_enabled = $1, wmi_enabled = $2, snmp_enabled = $3, ad_server = $4, ad_base_dn = $5,
            username = $6, snmp_communities = $7, updated_by = $8, updated_at = now(), scan_networks = $9, supply_threshold = $10${pw} WHERE id = 1`, vals);
  if (b.remote_connect && typeof b.remote_connect === 'object') {
    const r = b.remote_connect;
    await query('UPDATE netprobe_settings SET remote_connect = $1 WHERE id = 1',
      [JSON.stringify({ enabled: !!r.enabled, control: !!r.control, consent: !!r.consent })]);
  }
  res.json({ settings: await loadSettings() });
}));

// ---------------- Опрос ----------------
const now = () => new Date().toISOString();

/** Имя для AD/WMI: сетевое имя, иначе имя из DNS или NetBIOS */
function shortName(name) { return String(name || '').split('.')[0].toUpperCase(); }

/**
 * Опросить устройство. target: { hostname, ip, kind } (kind: 'computer' | 'printer' | 'other').
 * onUpdate вызывается после каждого готового раздела.
 */
async function probe(target, s, onUpdate) {
  const sections = {
    network: { state: 'running' },
    ad: { state: s.ad_enabled ? 'running' : 'off' },
    wmi: { state: s.wmi_enabled ? 'running' : 'off' },
    snmp: { state: s.snmp_enabled ? 'running' : 'off' },
  };
  const set = (k, v) => { sections[k] = { ...v, at: now() }; onUpdate(sections); };
  onUpdate(sections);

  const r = await P.resolveTarget(target);
  const ip = P.isIPv4(r.ip) ? r.ip : r.dns_ip;
  // Сетевая часть
  const net = (async () => {
    const t0 = Date.now();
    const [pg, ports, nb, mac] = await Promise.all([
      ip ? P.ping(ip) : { alive: false }, ip ? P.scanPorts(ip) : [], ip ? P.netbios(ip) : null, ip ? P.arpMac(ip) : '',
    ]);
    const data = {
      hostname: r.hostname, ip: r.ip, dns_ip: r.dns_ip, dns_name: r.dns_name, used_ip: ip || '',
      alive: pg.alive || ports.length > 0, ping: pg.alive, ping_ms: pg.ms, ports, netbios: nb, mac: mac || nb?.mac || '',
      ms: Date.now() - t0,
    };
    if (!ip) set('network', { state: 'error', error: target.hostname ? `Имя «${target.hostname}» не найдено в DNS` : 'Не указан IP-адрес', data });
    else set('network', { state: 'done', data });
    return data;
  })();

  // Имя для AD и WMI. Если известен только IP — берём имя из DNS или NetBIOS
  const nameFor = async () => {
    if (target.hostname) return target.hostname;
    if (r.dns_name) return r.dns_name;
    const n = await net;
    return n.netbios?.computer || '';
  };

  const ad = (async () => {
    if (!s.ad_enabled) return;
    if (target.kind === 'printer') return set('ad', { state: 'skipped', error: 'Для принтеров и МФУ не ищется' });
    const name = await nameFor();
    if (!name) return set('ad', { state: 'skipped', error: 'Неизвестно сетевое имя — искать в домене нечего' });
    const fqdn = name.includes('.') ? name : (r.dns_name.toUpperCase().startsWith(shortName(name) + '.') ? r.dns_name : '');
    const res = await adLookup(s, shortName(name), fqdn);
    if (res.error || res.ok === false) set('ad', { state: 'error', error: adError(res.error) });
    else if (!res.found) set('ad', { state: 'done', data: { found: false, name: shortName(name) } });
    else set('ad', { state: 'done', data: res });
  })();

  const wmi = (async () => {
    if (!s.wmi_enabled) return;
    if (target.kind === 'printer') return set('wmi', { state: 'skipped', error: 'Для принтеров и МФУ не опрашивается' });
    const n = await net;
    if (!n.used_ip) return set('wmi', { state: 'skipped', error: 'Устройство не найдено в сети' });
    const open = new Set(n.ports.map((p) => p.port));
    if (!open.has(135) && !open.has(5985)) {
      return set('wmi', { state: 'skipped', error: n.alive
        ? 'Порты WinRM (5985) и WMI (135) закрыты — это не Windows-компьютер или удалённый доступ запрещён брандмауэром'
        : 'Устройство не отвечает — возможно, выключено' });
    }
    // WinRM по IP без доверенных узлов не работает — по возможности используем имя
    const name = await nameFor();
    const res = await wmiCollect(s, name || n.used_ip);
    if (res.error) set('wmi', { state: 'error', error: wmiError(res.error) });
    else set('wmi', { state: 'done', data: normalizeWmi(res) });
  })();

  const snmp = (async () => {
    if (!s.snmp_enabled) return;
    const n = await net;
    if (!n.used_ip) return set('snmp', { state: 'skipped', error: 'Устройство не найдено в сети' });
    const res = await P.snmp(n.used_ip, communities(s));
    set('snmp', res ? { state: 'done', data: res } : { state: 'empty', error: 'Устройство не ответило по SNMP' });
  })();

  await Promise.all([net, ad, wmi, snmp]);
  return sections;
}

// Понятные объяснения частых ошибок
function adError(e) {
  const m = String(e || 'Ошибка');
  if (/password|парол|credential|учетн|учётн|logon failure|0x8007052E/i.test(m)) return `Неверный логин или пароль для домена. (${m})`;
  if (/server is not operational|сервер не работает|0x8007203A/i.test(m)) return `Контроллер домена недоступен — проверьте адрес в настройках. (${m})`;
  if (/referral|ссылк/i.test(m)) {
    return 'Контроллер домена ответил, что нужные данные в другом домене. Проверьте в настройках «Сведений из сети» поля '
      + `«Контроллер домена» и «Где искать (корневой DN)» — обычно их лучше оставить пустыми. (${m})`;
  }
  return m;
}
function wmiError(e) {
  const m = String(e || 'Ошибка');
  if (/access is denied|отказано в доступе|0x80070005/i.test(m)) {
    return `Доступ запрещён: у учётной записи из настроек нет прав администратора на этом компьютере. (${m})`;
  }
  if (/RPC|0x800706BA|недоступен|unavailable/i.test(m)) return `Компьютер недоступен по WMI: брандмауэр закрыт или компьютер выключен. (${m})`;
  return m;
}

// Объём диска «как на коробке»: 476,9 ГиБ → 512 ГБ
const SIZES = [32, 60, 64, 120, 128, 160, 240, 250, 256, 320, 480, 500, 512, 640, 750, 960, 1000, 1024, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 16000];
function marketGb(bytes) {
  const gb = bytes / 1e9;
  // Ближайший «магазинный» объём, если он отличается не больше чем на 6 %
  const near = SIZES.reduce((a, s) => (Math.abs(s - gb) < Math.abs(a - gb) ? s : a), SIZES[0]);
  return Math.abs(near - gb) / near < 0.06 ? near : Math.round(gb);
}
const fmtSize = (gb) => (gb >= 1000 && gb % 1000 === 0 ? `${gb / 1000} ТБ` : gb >= 1000 ? `${(gb / 1000).toFixed(1).replace('.', ',')} ТБ` : `${gb} ГБ`);

function normalizeWmi(d) {
  for (const k of ['cpu', 'memory_modules', 'disks', 'volumes', 'gpu', 'nics']) {
    if (d[k] == null) d[k] = [];
    else if (!Array.isArray(d[k])) d[k] = [d[k]]; // PowerShell 5.1: массив из одного элемента — объект
  }
  for (const x of d.disks) {
    x.gb = x.bytes ? marketGb(x.bytes) : null;
    // MediaType: 3 — HDD, 4 — SSD; BusType 17 — NVMe; USB-диски не учитываем
    x.kind = x.bus === 17 ? 'SSD' : x.media === 4 ? 'SSD' : x.media === 3 ? 'HDD' : /ssd|nvme/i.test(x.model) ? 'SSD' : '';
    x.usb = x.bus === 7 || /usb/i.test(x.iface || '');
  }
  return d;
}

// Значения для сравнения с карточкой и переноса в неё
/** Значения для карточки — по шаблонам и заменам службы ИТ (format.js) */
function suggestions(sections, opts) {
  return F.suggest(sections, opts);
}

/** Слить новые данные с прошлыми: раздел с ошибкой показывает прошлые данные с пометкой */
function mergeWithPrevious(sections, prev) {
  const out = {};
  for (const [k, v] of Object.entries(sections)) {
    const old = prev?.sections?.[k];
    const before = old?.state === 'done' ? { data: old.data, at: old.at } : old?.previous;
    out[k] = v.state === 'done' || !before ? v : { ...v, previous: before };
  }
  return out;
}

function deviceKind(typeCode, typeName) {
  const s = `${typeCode} ${typeName}`.toLowerCase();
  if (/prn|mfu|принтер|мфу|плоттер|сканер/.test(s)) return 'printer';
  return 'computer';
}

async function loadDevice(id) {
  const { rows } = await query(
    `SELECT d.id, d.hostname, d.ip_address, t.code AS type_code, t.name AS type_name
       FROM devices d JOIN device_types t ON t.id = d.type_id WHERE d.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Устройство не найдено');
  return rows[0];
}

function targetOf(d) {
  const hostname = String(d.hostname || '').trim();
  const ip = String(d.ip_address || '').trim();
  return {
    hostname: P.isHostname(hostname) ? hostname : '',
    ip: P.isIPv4(ip) ? ip : '',
    kind: deviceKind(d.type_code, d.type_name),
    bad: (hostname && !P.isHostname(hostname)) || (ip && !P.isIPv4(ip)),
  };
}

function startJob(key, target, userId, onDone) {
  if (jobs.has(key) && !jobs.get(key).done) return jobs.get(key);
  const running = [...jobs.values()].filter((j) => !j.done).length;
  if (running >= MAX_JOBS) throw new HttpError(429, 'Сейчас опрашиваются другие устройства. Попробуйте через минуту.');
  const job = { started_at: now(), target, sections: {}, done: false, by: userId };
  jobs.set(key, job);
  loadSettings({ withPassword: true })
    .then((s) => probe(target, s, (sections) => { job.sections = { ...sections }; }))
    .then(async (sections) => { job.sections = sections; await onDone?.(job); })
    .catch((e) => { job.error = e.message; console.error('Сведения из сети:', e); })
    .finally(() => { job.done = true; job.finished_at = now(); setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key); }, 120000); });
  return job;
}

const publicJob = (j) => (j ? { started_at: j.started_at, finished_at: j.finished_at || null, done: j.done, error: j.error || null, sections: j.sections } : null);

// Сохранённые сведения + идущий опрос
// ---------------- Подключение к сеансу пользователя (RDP shadow) ----------------
router.get('/remote', requireStaff, ah(async (req, res) => {
  res.json(Remote.settingsOf(await loadSettings()));
}));

router.get('/device/:id/connect.cmd', requireStaff, ah(async (req, res) => {
  const s = await loadSettings();
  if (!Remote.settingsOf(s).enabled) throw new HttpError(403, 'Подключение к сеансу отключено администратором');
  const { rows } = await query('SELECT id, hostname, ip_address FROM devices WHERE id = $1', [intOrNull(req.params.id)]);
  const d = rows[0];
  if (!d) throw new HttpError(404, 'Устройство не найдено');
  const target = String(d.hostname || '').trim() || String(d.ip_address || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,253}$/.test(target)) throw new HttpError(400, 'У устройства не указано сетевое имя или IP-адрес (допустимы латиница, цифры, точка, дефис)');
  await query(`INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'remote_connect', $3)`,
    [d.id, req.user.id, JSON.stringify({ 'Подключение': [null, target] })]);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="connect-${target.replace(/[^\w.-]/g, '')}.cmd"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Remote.cmdFile(target, s));
}));

router.get('/device/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const d = await loadDevice(id);
  const { rows } = await query(
    `SELECT n.data, n.collected_at,
            CASE WHEN u.is_service THEN 'Служба ИТ' ELSE u.full_name END AS full_name,
            CASE WHEN u.is_service THEN 'Служба ИТ' ELSE u.username END AS username FROM device_netinfo n
       LEFT JOIN users u ON u.id = n.collected_by WHERE n.device_id = $1`, [id]);
  // Предложения для карточки пересчитываются при каждом открытии
  const fopts = await F.loadFormatOpts();
  const saved = rows[0] ? { ...rows[0].data, suggest: suggestions(rows[0].data.sections || {}, fopts), collected_at: rows[0].collected_at, collected_by: rows[0].full_name || rows[0].username } : null;
  const t = targetOf(d);
  res.json({
    target: { hostname: d.hostname, ip: d.ip_address, kind: t.kind, usable: !!(t.hostname || t.ip), bad: t.bad },
    saved, job: publicJob(jobs.get(id)), configured: !!(await loadSettings()).updated_at,
  });
}));

router.post('/device/:id/refresh', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const d = await loadDevice(id);
  const t = targetOf(d);
  if (t.bad) throw new HttpError(400, 'Сетевое имя или IP-адрес записаны с ошибкой — исправьте их в карточке');
  if (!t.hostname && !t.ip) throw new HttpError(400, 'У устройства не указаны сетевое имя или IP-адрес');
  const job = startJob(id, t, req.user.id, async (j) => {
    const prev = (await query('SELECT data FROM device_netinfo WHERE device_id = $1', [id])).rows[0]?.data;
    const sections = mergeWithPrevious(j.sections, prev);
    j.sections = sections;
    const data = { target: { hostname: t.hostname, ip: t.ip }, sections, suggest: suggestions(sections) };
    await query(
      `INSERT INTO device_netinfo (device_id, data, collected_at, collected_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (device_id) DO UPDATE SET data = EXCLUDED.data, collected_at = now(), collected_by = EXCLUDED.collected_by`,
      [id, JSON.stringify(data), req.user.id]);
    if (sections.network?.data?.alive) await markSeen([id]);
  });
  res.status(202).json({ job: publicJob(job) });
}));

// Проверка настроек на любом компьютере (администратор портала)
router.post('/test', requireSuperadmin, ah(async (req, res) => {
  const name = String(req.body.target || '').trim();
  const isIp = P.isIPv4(name);
  if (!isIp && !P.isHostname(name)) throw new HttpError(400, 'Укажите сетевое имя или IP-адрес компьютера');
  const key = 'test:' + name.toUpperCase();
  const job = startJob(key, { hostname: isIp ? '' : name, ip: isIp ? name : '', kind: req.body.kind === 'printer' ? 'printer' : 'computer' }, req.user.id);
  res.status(202).json({ key, job: publicJob(job) });
}));

router.get('/test', requireSuperadmin, ah(async (req, res) => {
  const job = jobs.get(String(req.query.key || ''));
  if (!job) throw new HttpError(404, 'Проверка не найдена — запустите ещё раз');
  res.json({ job: { ...publicJob(job), suggest: job.done ? suggestions(job.sections, await F.loadFormatOpts()) : null } });
}));

// ---------------- Шаблоны значений и замены (редакторы и администратор) ----------------
router.get('/formats', requireStaff, ah(async (req, res) => {
  const o = await F.loadFormatOpts();
  res.json({
    fields: F.FIELDS, vars: F.VARS, defaults: F.DEFAULT_FORMATS, formats: { ...F.DEFAULT_FORMATS, ...o.formats },
    replacements: o.replacements, preview: F.suggest(F.SAMPLE, o),
  });
}));
const cleanFormats = (b) => {
  const out = {};
  for (const k of Object.keys(F.FIELDS)) {
    const v = str(b?.[k], 300);
    if (v && v !== F.DEFAULT_FORMATS[k]) out[k] = v;
  }
  return out;
};
router.post('/formats/preview', requireStaff, ah(async (req, res) => {
  res.json({ preview: F.suggest(F.SAMPLE, { formats: cleanFormats(req.body.formats) }) });
}));
router.put('/formats', requireStaff, ah(async (req, res) => {
  const formats = cleanFormats(req.body.formats);
  await query(`INSERT INTO netprobe_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await query('UPDATE netprobe_settings SET formats = $1 WHERE id = 1', [JSON.stringify(formats)]);
  res.json({ ok: true });
}));
const REPL_FIELDS = ['model', 'cpu', 'ram', 'storage', 'os', 'hostname', 'serial_number', 'mac_address'];
router.post('/replacements', requireStaff, ah(async (req, res) => {
  const field = String(req.body.field || '');
  const src = str(req.body.src, 300), dst = str(req.body.dst, 300);
  if (!REPL_FIELDS.includes(field)) throw new HttpError(400, 'Неизвестное поле');
  if (!src || !dst) throw new HttpError(400, 'Укажите оба значения');
  const { rows } = await query(
    `INSERT INTO netprobe_replacements (field, src, dst, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (field, lower(src)) DO UPDATE SET dst = EXCLUDED.dst RETURNING id`, [field, src, dst, req.user.id]);
  res.json({ id: rows[0].id });
}));
router.delete('/replacements/:id', requireStaff, ah(async (req, res) => {
  await query('DELETE FROM netprobe_replacements WHERE id = $1', [intOrNull(req.params.id)]);
  res.json({ ok: true });
}));

/** Техника ответила в сети — для уведомления «давно не в сети» */
async function markSeen(ids) {
  const list = [...new Set(ids.map(Number).filter((n) => n > 0))];
  if (!list.length) return;
  await query(`INSERT INTO device_seen (device_id, last_seen) SELECT unnest($1::int[]), now()
               ON CONFLICT (device_id) DO UPDATE SET last_seen = now()`, [list]);
}

module.exports = router;
module.exports.suggestions = suggestions;
module.exports.loadFormatOpts = F.loadFormatOpts;
module.exports.loadSettings = loadSettings;
module.exports.normalizeWmi = normalizeWmi;
module.exports.communities = communities;
module.exports.wmiError = wmiError;
module.exports.markSeen = markSeen;
