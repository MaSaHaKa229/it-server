// Сканирование сети в отдельном процессе с пониженным приоритетом.
// Раньше сканирование шло в процессе портала и забирало его ресурсы — сайт открывался с задержкой.
// Теперь портал (scan.js) запускает этот файл, передаёт задание сообщением и получает ход работы и результат.
// Здесь только сеть: ни базы, ни веб-сервера. Пароль для WMI приходит сообщением (не в командной строке).
//
// 1. Главные порты (7 штук) у всех адресов; отказ в подключении тоже считается ответом устройства.
// 2. Свои подсети сервера — по ARP-таблице: после попыток подключения в ней уже есть все включённые устройства,
//    поэтому ping запускается только для адресов из других подсетей (не больше 16 одновременно).
// 3. Остальные порты — только у найденных устройств.
// 4. Опознание: DNS, NetBIOS, SNMP. 5. WMI — пакетами по несколько компьютеров на один PowerShell,
//    а для компьютеров, чьи характеристики уже собраны недавно и не изменились имя и MAC, — из прошлого сканирования.
const os = require('os');
const P = require('./probes');
const { wmiCollectMany } = require('./powershell');

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* нет прав — не страшно */ }
process.on('disconnect', () => process.exit(0)); // портал остановлен — выходим

const ipToInt = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

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
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (/FAILED|INCOMPLETE/i.test(line)) continue;
    const ip = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    const mac = line.match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i);
    if (!ip || !mac) continue;
    const m = mac[0].replace(/[-:]/g, '').toUpperCase();
    if (m === 'FFFFFFFFFFFF' || m === '000000000000' || /^01005E/.test(m)) continue; // широковещательные и групповые
    map.set(ip[1], m.match(/../g).join(':'));
  }
  return map;
}

/** Подсети сетевых карт сервера: [[начало, конец]] — адреса в них видны в ARP-таблице */
function localRanges() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const mask = ipToInt(a.netmask || '255.255.255.0');
      const base = (ipToInt(a.address) & mask) >>> 0;
      out.push([base, (base | (~mask >>> 0)) >>> 0]);
    }
  }
  return out;
}

let progress = { phase: 'Подготовка', done: 0, total: 0, found: 0 };
let lastSent = 0;
function report(force) {
  const now = Date.now();
  if (!force && now - lastSent < 400) return;
  lastSent = now;
  if (process.connected) process.send({ type: 'progress', ...progress });
}
const phase = (name, total) => { Object.assign(progress, { phase: name, done: 0, total }); report(true); };
const tick = () => { progress.done++; report(); };

async function run(task) {
  const { ranges, snmp, wmi, cred, cache } = task;
  const ips = [];
  for (const [s, e] of ranges) for (let n = s; n <= e; n++) ips.push(intToIp(n));
  const local = localRanges();
  const isLocal = (ip) => { const n = ipToInt(ip); return local.some(([a, b]) => n >= a && n <= b); };
  const inRange = (ip) => { const n = ipToInt(ip); return ranges.some(([a, b]) => n >= a && n <= b); };

  // ARP-таблица — снимки во время проверки портов (записи в ней живут недолго), всё копится
  const arp = new Map();
  const snapArp = async () => { for (const [ip, mac] of await arpTable()) arp.set(ip, mac); };
  let arpTimer = null;
  const arpLoop = () => { arpTimer = setTimeout(() => snapArp().catch(() => {}).finally(() => { if (arpTimer) arpLoop(); }), 4000); };

  // 1. Главные порты
  const alive = new Map(); // ip → { ports, ping, arpOnly }
  phase('Поиск устройств: проверка портов', ips.length);
  arpLoop();
  const refusedOnly = new Set();
  await pool(ips, 48, async (ip) => {
    const r = await P.probePorts(ip, P.MAIN_PORTS);
    if (r.alive) alive.set(ip, { ports: r.open, ping: null });
    if (r.alive && !r.open.length) refusedOnly.add(ip);
    progress.found = alive.size;
    tick();
  });
  clearTimeout(arpTimer); arpTimer = null;
  // Межсетевой экран, который отвечает отказом за любой адрес: если в подсети /24 так «ответили» почти все
  // адреса — отказ там не признак устройства (такие адреса проверятся по ARP или ping)
  const by24 = new Map();
  for (const ip of ips) { const k = ip.replace(/\.\d+$/, ''); const g = by24.get(k) || { n: 0, ref: [] }; g.n++; if (refusedOnly.has(ip)) g.ref.push(ip); by24.set(k, g); }
  for (const g of by24.values()) if (g.n >= 16 && g.ref.length > g.n * 0.8) for (const ip of g.ref) alive.delete(ip);
  progress.found = alive.size;
  await snapArp().catch(() => {});

  // 2. Свои подсети — по ARP; чужие — ping
  for (const ip of ips) if (!alive.has(ip) && arp.has(ip)) alive.set(ip, { ports: [], ping: null, arpOnly: true });
  const rest = ips.filter((ip) => !alive.has(ip) && !isLocal(ip));
  if (rest.length) {
    phase('Поиск устройств: ping (другие подсети)', rest.length);
    await pool(rest, 16, async (ip) => {
      const pg = await P.ping(ip, 800);
      if (pg.alive) alive.set(ip, { ports: [], ping: pg.ms });
      progress.found = alive.size;
      tick();
    });
  }
  progress.found = alive.size;

  // 3. Остальные порты — только у найденных
  const list = [...alive.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  const other = P.PORTS.map(([p]) => p).filter((p) => !P.MAIN_PORTS.includes(p));
  phase('Поиск устройств: остальные порты', list.length);
  await pool(list, 16, async (ip) => {
    const a = alive.get(ip);
    const r = await P.probePorts(ip, other);
    if (r.open.length) a.ports = [...a.ports, ...r.open].sort((x, y) => x.port - y.port);
    if (a.arpOnly && (r.alive || a.ports.length)) a.arpOnly = false;
    tick();
  });
  await snapArp().catch(() => {});
  for (const ip of arp.keys()) if (inRange(ip) && !alive.has(ip)) alive.set(ip, { ports: [], ping: null, arpOnly: true });

  // 4. Опознание
  const hosts = [];
  const dns = require('dns').promises;
  const all = [...alive.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  phase('Опознание устройств: имена, NetBIOS, SNMP', all.length);
  await pool(all, 32, async (ip) => {
    const a = alive.get(ip);
    const [names, nb, sn] = await Promise.all([
      Promise.race([dns.reverse(ip).catch(() => []), new Promise((r) => setTimeout(() => r([]), 3000))]),
      P.netbios(ip),
      snmp ? P.snmp(ip, snmp) : null,
    ]);
    hosts.push({
      ip, ports: a.ports, ping: a.ping, arp_only: !!a.arpOnly,
      dns_name: names[0] || '', netbios: nb || null, mac: arp.get(ip) || nb?.mac || '', snmp: sn || null,
    });
    tick();
  });

  // 5. WMI — только Windows-компьютеры с открытыми портами WMI/WinRM
  if (wmi) {
    const nameOf = (h) => h.netbios?.computer || (h.dns_name ? h.dns_name.split('.')[0] : '') || h.ip;
    const norm = (x) => String(x || '').toUpperCase();
    const targets = [];
    for (const h of hosts.filter((x) => x.ports.some((p) => p.port === 135 || p.port === 5985))) {
      // Недавно собранные характеристики того же компьютера (то же имя и MAC) — берём из прошлого сканирования
      const c = (cache || []).find((x) => norm(x.name) === norm(nameOf(h)) && (!x.mac || !h.mac || norm(x.mac) === norm(h.mac)));
      if (c) { h.wmi = c.wmi; h.wmi_cached = c.at || true; } else targets.push(h);
    }
    phase('Характеристики компьютеров (WMI)', targets.length);
    const groups = [];
    for (let i = 0; i < targets.length; i += 6) groups.push(targets.slice(i, i + 6));
    await pool(groups, 2, async (g) => {
      const res = await wmiCollectMany(cred, g.map(nameOf));
      for (const h of g) { h.wmi_raw = res.get(nameOf(h)) || { error: 'Нет ответа' }; tick(); }
    });
  }
  report(true);
  return hosts;
}

process.once('message', (task) => {
  run(task)
    .then((hosts) => process.send({ type: 'done', hosts }))
    .catch((e) => process.send({ type: 'error', error: e.message || String(e) }))
    .finally(() => setTimeout(() => process.exit(0), 200));
});
