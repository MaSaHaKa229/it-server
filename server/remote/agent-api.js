// API для агентов (/remote/agent-api). Доступно и на порту портала, и на порту сайта заявок —
// чтобы агент работал и по имени it-portal, и по IP-адресу сервера (nginx отправляет его на сайт заявок).
//   GET  /public-key  — открытый ключ сервера (для установки агента без файла ключа)
//   POST /register    — регистрация: код регистрации → ключ агента
//   POST /heartbeat   — «пульс» раз в 30 с: состояние, адреса, пользователь Windows
//   POST /event       — события сеанса: начат, завершён, отклонён пользователем…
const express = require('express');
const { HttpError, ah, str } = require('../inventory/util');
const L = require('./lib');
const { ensureKey, randomSecret, sha256 } = require('./keys');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

// Простая защита от перебора кода регистрации: 20 неудачных попыток за 15 минут с одного адреса
const fails = new Map();
function tooMany(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.count >= 20;
}
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) fails.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

/** Поля, которые агент сообщает о себе */
function agentFields(b, ip) {
  const fp = String(b.fingerprint || '').toLowerCase();
  const port = Number(b.port);
  return {
    computer_name: str(b.computerName, 100) || ip,
    os: str(b.os, 200),
    version: str(b.version, 30),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 5960,
    fingerprint: HEX64.test(fp) ? fp : null,
    ips: L.list(b.ips).filter(L.isIPv4),
    macs: L.list(b.macs).map(L.normMac).filter(Boolean),
    windows_user: str(b.windowsUser, 200),
    seen_ip: ip,
  };
}

async function authAgent(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
  const id = String(req.body.agentId || '');
  if (!m || !UUID.test(id)) throw new HttpError(401, 'Агент не зарегистрирован');
  const { rows } = await L.query('SELECT * FROM remote.agents WHERE id = $1 AND key_hash = $2', [id, sha256(m[1])]);
  if (!rows[0]) throw new HttpError(401, 'Агент не зарегистрирован');
  return rows[0];
}

function router() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));

  r.get('/public-key', ah(async (req, res) => {
    const k = await ensureKey(L.db);
    res.set('X-Key-Fingerprint', k.fingerprint).type('text/plain').send(k.publicPem);
  }));

  r.post('/register', ah(async (req, res) => {
    const ip = L.clientIp(req);
    if (tooMany(ip)) throw new HttpError(429, 'Слишком много попыток');
    const b = req.body || {};
    const id = String(b.agentId || '');
    if (!UUID.test(id)) throw new HttpError(400, 'Неверный id агента');
    const s = await L.getSettings();
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code !== s.registration_code.replace(/-/g, '')) {
      fail(ip);
      throw new HttpError(403, 'Неверный код регистрации');
    }
    const f = agentFields(b, ip);
    // Повторная регистрация того же агента разрешена только с тем же сертификатом:
    // иначе знающий код регистрации мог бы «подменить» чужой компьютер
    const prev = (await L.query('SELECT fingerprint FROM remote.agents WHERE id = $1', [id])).rows[0];
    if (prev && prev.fingerprint && prev.fingerprint !== f.fingerprint) {
      throw new HttpError(409, 'Агент с таким id уже зарегистрирован с другим сертификатом. Удалите его на странице «Удалённый доступ» и повторите.');
    }
    const key = randomSecret();
    const { rows } = await L.query(
      `INSERT INTO remote.agents (id, key_hash, computer_name, os, version, port, fingerprint, ips, macs, seen_ip, windows_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, computer_name = EXCLUDED.computer_name, os = EXCLUDED.os,
         version = EXCLUDED.version, port = EXCLUDED.port, fingerprint = EXCLUDED.fingerprint, ips = EXCLUDED.ips,
         macs = EXCLUDED.macs, seen_ip = EXCLUDED.seen_ip, windows_user = EXCLUDED.windows_user, last_seen = now()
       RETURNING *`,
      [id, sha256(key), f.computer_name, f.os, f.version, f.port, f.fingerprint, f.ips, f.macs, f.seen_ip, f.windows_user]);
    const a = rows[0];
    if (!a.device_id && !a.device_manual) {
      const dev = await L.matchDevice(a);
      if (dev) await L.query('UPDATE remote.agents SET device_id = $2 WHERE id = $1', [id, dev]);
    }
    console.log(`Удалённый доступ: зарегистрирован агент ${f.computer_name} (${ip})`);
    res.json({ agentKey: key, heartbeatSec: 30 });
  }));

  r.post('/heartbeat', ah(async (req, res) => {
    const a = await authAgent(req);
    const f = agentFields(req.body || {}, L.clientIp(req));
    if (a.fingerprint && f.fingerprint && a.fingerprint !== f.fingerprint) {
      console.warn(`Удалённый доступ: у агента ${a.computer_name} сменился сертификат`);
    }
    await L.query(
      `UPDATE remote.agents SET computer_name = $2, os = $3, version = $4, port = $5, fingerprint = coalesce($6, fingerprint),
         ips = $7, macs = $8, seen_ip = $9, windows_user = $10, last_seen = now() WHERE id = $1`,
      [a.id, f.computer_name, f.os, f.version, f.port, f.fingerprint, f.ips, f.macs, f.seen_ip, f.windows_user]);
    if (!a.device_id && !a.device_manual) {
      const dev = await L.matchDevice({ ...a, ...f });
      if (dev) await L.query('UPDATE remote.agents SET device_id = $2 WHERE id = $1', [a.id, dev]);
    }
    res.json({ ok: true, heartbeatSec: 30 });
  }));

  const EVENTS = { started: 'started', ended: 'ended', denied: 'denied', no_answer: 'no_answer', failed: 'failed' };
  r.post('/event', ah(async (req, res) => {
    const a = await authAgent(req);
    const b = req.body || {};
    const ev = EVENTS[b.event];
    const sid = String(b.sid || '');
    if (!ev || !UUID.test(sid)) throw new HttpError(400, 'Неверное событие');
    const time = ev === 'started' ? 'started_at = coalesce(started_at, now())' : 'ended_at = coalesce(ended_at, now())';
    await L.query(
      `UPDATE remote.sessions SET status = $3, ${time}, windows_user = coalesce($4, windows_user), detail = coalesce($5, detail)
        WHERE id = $1 AND agent_id = $2 AND status NOT IN ('ended', 'denied', 'no_answer', 'failed')`,
      [sid, a.id, ev, str(b.windowsUser, 200), str(b.detail, 500)]);
    await L.query('UPDATE remote.agents SET last_seen = now() WHERE id = $1', [a.id]);
    res.json({ ok: true });
  }));

  r.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  return r;
}

module.exports = { router };
