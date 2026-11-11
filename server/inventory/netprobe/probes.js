// Сетевые проверки без паролей: DNS, ping, открытые порты, NetBIOS, ARP, SNMP.
// Всё на встроенных модулях Node.js — ничего устанавливать не нужно.
const dns = require('dns').promises;
const dgram = require('dgram');
const net = require('net');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Сетевое имя: буквы, цифры, точка, дефис, подчёркивание (NetBIOS допускает «_»)
const HOSTNAME = /^[A-Za-z0-9_]([A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?$/;

const isIPv4 = (s) => IPV4.test(String(s || ''));
const isHostname = (s) => HOSTNAME.test(String(s || '')) && !/\.\./.test(s);

/** Запустить программу без оболочки (аргументы не интерпретируются) */
function runFile(file, args, { timeout = 5000, env, encoding = 'latin1' } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env, windowsHide: true, encoding, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, killed: !!(err && err.killed), stdout: stdout || '', stderr: stderr || '' }));
  });
}

const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

/** Имя → IPv4 и IP → имя */
async function resolveTarget({ hostname, ip }) {
  const out = { hostname: hostname || '', ip: ip || '', dns_ip: '', dns_name: '' };
  if (hostname) {
    const r = await withTimeout(dns.lookup(hostname, { family: 4 }).catch(() => null), 3000, null);
    if (r) out.dns_ip = r.address;
  }
  const rip = out.ip || out.dns_ip;
  if (rip) {
    const names = await withTimeout(dns.reverse(rip).catch(() => []), 3000, []);
    if (names[0]) out.dns_name = names[0];
  }
  return out;
}

/** ping: { alive, ms } */
async function ping(ip) {
  if (!isIPv4(ip)) return { alive: false };
  const r = IS_WIN
    ? await runFile('ping', ['-n', '1', '-w', '1200', ip], { timeout: 4000 })
    : await runFile('ping', ['-c', '1', '-W', '1', ip], { timeout: 4000 });
  const out = r.stdout;
  const alive = /TTL=/i.test(out);
  // Windows (в т.ч. русская): «время<1мс TTL=128» / «time=12ms TTL=…»; Linux: «ttl=64 time=0.04 ms»
  const m = out.match(/[=<](\d+)\D{0,6}TTL=/i) || out.match(/time[=<]([\d.]+)/i);
  return { alive, ms: alive && m ? Math.round(Number(m[1])) : null };
}

const PORTS = [
  [21, 'FTP'], [22, 'SSH'], [23, 'Telnet'], [80, 'HTTP (веб-интерфейс)'], [135, 'RPC / WMI'], [139, 'NetBIOS'],
  [443, 'HTTPS'], [445, 'Общие папки (SMB)'], [515, 'Печать LPD'], [631, 'Печать IPP'], [3389, 'Удалённый рабочий стол (RDP)'],
  [5900, 'VNC'], [5985, 'WinRM'], [8080, 'HTTP (доп.)'], [9100, 'Печать RAW (9100)'],
];

function tcpOpen(ip, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, ip);
  });
}

async function scanPorts(ip) {
  if (!isIPv4(ip)) return [];
  const res = await Promise.all(PORTS.map(async ([port, label]) => ((await tcpOpen(ip, port)) ? { port, label } : null)));
  return res.filter(Boolean);
}

/** Отправить UDP-пакет и дождаться одного ответа */
function udpRequest(ip, port, packet, timeout) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(t); try { sock.close(); } catch { /* уже закрыт */ } resolve(v); } };
    const t = setTimeout(() => end(null), timeout);
    sock.on('message', (msg) => end(msg));
    sock.on('error', () => end(null));
    sock.send(packet, port, ip, (err) => { if (err) end(null); });
  });
}

// cp866 — так NetBIOS-имена приходят с русской Windows
const CP866_HI = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ';
const cp866 = (buf) => [...buf].map((b) => (b < 128 ? String.fromCharCode(b) : CP866_HI[b - 128])).join('');
const CP1251_HI = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
const cp1251 = (buf) => [...buf].map((b) => (b < 128 ? String.fromCharCode(b) : CP1251_HI[b - 128])).join('');

const fmtMac = (hex) => hex.toUpperCase().match(/../g).join(':');

/** NetBIOS: имя компьютера, рабочая группа/домен, вошедший пользователь, MAC */
async function netbios(ip, timeout = 1500) {
  if (!isIPv4(ip)) return null;
  const name = Buffer.alloc(16); name[0] = 0x2a; // «*»
  const enc = [0x20];
  for (const c of name) enc.push((c >> 4) + 0x41, (c & 0x0f) + 0x41);
  enc.push(0);
  const pkt = Buffer.from([0x4e, 0x4d, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...enc, 0, 0x21, 0, 1]);
  const data = await udpRequest(ip, 137, pkt, timeout);
  if (!data || data.length < 57) return null;
  try {
    let off = 56;
    const num = data[off++];
    const names = [];
    for (let i = 0; i < num && off + 18 <= data.length; i++) {
      names.push({ name: cp866(data.subarray(off, off + 15)).trim(), suffix: data[off + 15], group: (data.readUInt16BE(off + 16) & 0x8000) !== 0 });
      off += 18;
    }
    const res = { computer: '', workgroup: '', user: '', mac: '' };
    for (const x of names) {
      if (x.suffix === 0x00 && !x.group && !res.computer) res.computer = x.name;
      else if (x.suffix === 0x00 && x.group && !res.workgroup) res.workgroup = x.name;
    }
    for (const x of names) {
      if (x.suffix === 0x03 && !x.group && x.name.toUpperCase() !== res.computer.toUpperCase() && !x.name.includes('MSBROWSE')) res.user = x.name;
    }
    if (off + 6 <= data.length) {
      const mac = data.subarray(off, off + 6).toString('hex');
      if (mac !== '000000000000') res.mac = fmtMac(mac);
    }
    return res;
  } catch {
    return null;
  }
}

/** MAC из ARP-таблицы сервера (только если устройство в той же подсети) */
async function arpMac(ip) {
  if (!isIPv4(ip)) return '';
  const r = IS_WIN ? await runFile('arp', ['-a', ip], { timeout: 4000 }) : await runFile('ip', ['neigh', 'show', ip], { timeout: 4000 });
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.includes(ip)) continue;
    const m = line.match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i);
    if (m) return fmtMac(m[0].replace(/[-:]/g, ''));
  }
  return '';
}

// ---------------- SNMP (v2c, затем v1), только чтение ----------------
const berLen = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, v) => Buffer.concat([Buffer.from([tag]), berLen(v.length), v]);
const berInt = (v) => {
  const b = [];
  for (;;) {
    b.unshift(v & 0xff);
    v = Math.floor(v / 256);
    if (v === 0 && !(b[0] & 0x80)) break;
  }
  return tlv(0x02, Buffer.from(b));
};
function berOID(oid) {
  const p = oid.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let x of p.slice(2)) {
    const enc = [x & 0x7f];
    x = Math.floor(x / 128);
    while (x > 0) { enc.unshift(0x80 | (x & 0x7f)); x = Math.floor(x / 128); }
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
function berParse(data, off) {
  const tag = data[off++];
  let len = data[off++];
  if (len & 0x80) {
    const nb = len & 0x7f;
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + data[off + i];
    off += nb;
  }
  if (off + len > data.length) throw new Error('битый пакет');
  return { tag, val: data.subarray(off, off + len), next: off + len };
}
function berChildren(data) {
  const out = [];
  for (let off = 0; off < data.length;) { const x = berParse(data, off); out.push(x); off = x.next; }
  return out;
}
function decodeOID(v) {
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (const b of v.subarray(1)) { n = n * 128 + (b & 0x7f); if (!(b & 0x80)) { parts.push(n); n = 0; } }
  return parts.join('.');
}

// Принтеры: расходники (тонер, барабан) 1..6 — описание, ёмкость, остаток
const SUPPLY = [1, 2, 3, 4, 5, 6];
const SNMP_OIDS = [
  ['1.3.6.1.2.1.1.1.0', 'sysDescr'], ['1.3.6.1.2.1.1.3.0', 'sysUpTime'], ['1.3.6.1.2.1.1.4.0', 'sysContact'],
  ['1.3.6.1.2.1.1.5.0', 'sysName'], ['1.3.6.1.2.1.1.6.0', 'sysLocation'],
  ['1.3.6.1.2.1.25.3.2.1.3.1', 'model'], ['1.3.6.1.2.1.43.5.1.1.17.1', 'serial'],
  ['1.3.6.1.2.1.43.10.2.1.4.1.1', 'pageCount'],
  ['1.3.6.1.2.1.47.1.1.1.1.11.1', 'entitySerial'], ['1.3.6.1.2.1.47.1.1.1.1.13.1', 'entityModel'],
];
const SUPPLY_OIDS = SUPPLY.flatMap((i) => [
  [`1.3.6.1.2.1.43.11.1.1.6.1.${i}`, `supply${i}_name`],
  [`1.3.6.1.2.1.43.11.1.1.8.1.${i}`, `supply${i}_max`],
  [`1.3.6.1.2.1.43.11.1.1.9.1.${i}`, `supply${i}_level`],
]);

async function snmpGet(ip, community, oids, version, timeout) {
  const reqId = Math.floor(Math.random() * 0x7fffffff);
  const vbl = Buffer.concat(oids.map(([o]) => tlv(0x30, Buffer.concat([berOID(o), Buffer.from([0x05, 0x00])]))));
  const pdu = tlv(0xa0, Buffer.concat([berInt(reqId), berInt(0), berInt(0), tlv(0x30, vbl)]));
  const msg = tlv(0x30, Buffer.concat([berInt(version), tlv(0x04, Buffer.from(community, 'latin1')), pdu]));
  const data = await udpRequest(ip, 161, msg, timeout);
  if (!data) return null;
  try {
    const items = berChildren(berParse(data, 0).val);
    const fields = berChildren(items[2].val);
    const errStatus = fields[1].val;
    if (errStatus.length && errStatus[errStatus.length - 1] !== 0) return { _error: true };
    const names = Object.fromEntries(oids);
    const res = {};
    for (const vb of berChildren(fields[3].val)) {
      const [k, v] = berChildren(vb.val);
      const name = names[decodeOID(k.val)] || decodeOID(k.val);
      if ([0x80, 0x81, 0x82, 0x05].includes(v.tag)) continue; // нет такого значения
      if (v.tag === 0x04) {
        const s = v.val.toString('utf8');
        res[name] = (s.includes('�') ? cp1251(v.val) : s).replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 300);
      } else if ([0x02, 0x41, 0x42, 0x43, 0x46].includes(v.tag)) {
        let x = 0n;
        for (const b of v.val) x = x * 256n + BigInt(b);
        // INTEGER — со знаком; счётчики и TimeTicks — без знака
        if (v.tag === 0x02 && v.val.length && v.val[0] & 0x80) x -= 1n << BigInt(8 * v.val.length);
        res[name] = Number(x);
      } else if (v.tag === 0x06) res[name] = decodeOID(v.val);
    }
    return res;
  } catch {
    return null;
  }
}

/** Опрос SNMP: модель, серийный номер, счётчик страниц, расходники */
async function snmp(ip, communities, timeout = 1500) {
  if (!isIPv4(ip)) return null;
  for (const comm of communities) {
    for (const version of [1, 0]) {
      let r = await snmpGet(ip, comm, SNMP_OIDS, version, timeout);
      if (!r) continue; // нет ответа — следующая версия/сообщество
      if (r._error) r = await snmpGet(ip, comm, SNMP_OIDS.slice(0, 5), version, timeout); // v1: ошибка, если хоть одного OID нет
      if (!r || r._error || !Object.keys(r).length) continue;
      const sup = (await snmpGet(ip, comm, SUPPLY_OIDS, version, timeout)) || {};
      const supplies = [];
      if (!sup._error) {
        for (const i of SUPPLY) {
          const name = sup[`supply${i}_name`];
          if (!name) continue;
          const max = sup[`supply${i}_max`], lvl = sup[`supply${i}_level`];
          supplies.push({ name, percent: max > 0 && lvl >= 0 ? Math.round((lvl / max) * 100) : null });
        }
      }
      const up = r.sysUpTime;
      return {
        community: comm, version: version ? 'v2c' : 'v1',
        name: r.sysName || '', description: r.sysDescr || '', location: r.sysLocation || '', contact: r.sysContact || '',
        model: r.model || r.entityModel || '', serial: r.serial || r.entitySerial || '',
        page_count: Number.isFinite(r.pageCount) ? r.pageCount : null,
        uptime: Number.isFinite(up) ? `${Math.floor(up / 8640000)} д ${Math.floor((up % 8640000) / 360000)} ч` : '',
        supplies,
      };
    }
  }
  return null;
}

module.exports = { isIPv4, isHostname, resolveTarget, ping, scanPorts, netbios, arpMac, snmp, runFile, PORTS, IS_WIN };
