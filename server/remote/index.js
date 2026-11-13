// Удалённый доступ: API портала (/remote/api) и подключение просмотрщика.
//   view    — подключаться в режиме «только просмотр», видеть свои подключения
//   control — плюс управлять мышью и клавиатурой
//   admin   — плюс настройки, все подключения, привязка агентов к технике, режим «без уведомления»
const express = require('express');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');
const { level, atLeast } = require('../portal/modules');
const L = require('./lib');
const { ensureKey, signToken, randomSecret, sha256 } = require('./keys');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOWNLOADS = path.join(__dirname, '..', '..', 'public', 'remote', 'downloads');
const displayName = (u) => (u.full_name && u.full_name.trim()) || u.username;

const requireLevel = (min) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (!atLeast(req.user, 'remote', min)) return res.status(403).json({ error: 'Нет доступа к удалённому подключению' });
  next();
};

/** Адрес портала для просмотрщика (как его видит браузер специалиста) */
function serverAddress(req) {
  if (process.env.PORTAL_URL) {
    try { return new URL(process.env.PORTAL_URL).host; } catch { /* ниже — из запроса */ }
  }
  return String(req.get('host') || '').replace(/[^\w.:-]/g, '');
}

function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  // ---------- Просмотрщик: получить параметры подключения по одноразовому пропуску ----------
  // Вызывается программой специалиста, а не браузером, поэтому без сессии портала.
  r.post('/connect', ah(async (req, res) => {
    const b = req.body || {};
    const sid = String(b.session || '');
    const ticket = String(b.ticket || '');
    if (!UUID.test(sid) || ticket.length < 20) throw new HttpError(400, 'Неверная ссылка');
    // Пропуск «гасится» одним запросом — второй раз по той же ссылке подключиться нельзя
    const { rows } = await L.query(
      `UPDATE remote.sessions SET status = 'opened', opened_at = now(), viewer_ip = $3, viewer_ticket_hash = NULL
        WHERE id = $1 AND viewer_ticket_hash = $2 AND status = 'issued' AND expires_at > now()
       RETURNING *`, [sid, sha256(ticket), L.clientIp(req)]);
    const s = rows[0];
    if (!s) throw new HttpError(410, 'Ссылка на подключение устарела или уже использована. Нажмите «Подключиться» на портале ещё раз.');
    const a = (await L.query('SELECT * FROM remote.agents WHERE id = $1', [s.agent_id])).rows[0];
    if (!a) throw new HttpError(404, 'Агент удалён');
    const key = await ensureKey(L.db);
    const now = Math.floor(Date.now() / 1000);
    const settings = await L.getSettings();
    const token = signToken(key, {
      v: 1, sid: s.id, aid: a.id, uid: s.user_id, user: s.user_name, mode: s.mode, consent: s.consent,
      iat: now, exp: now + Math.max(30, settings.token_ttl),
    });
    res.json({
      host: L.agentHost(a), port: a.port, fingerprint: a.fingerprint, token,
      computerName: a.computer_name, mode: s.mode, technician: s.user_name,
    });
  }));

  // Всё остальное — только для вошедших в портал
  r.use(requireLevel('view'));

  r.get('/me', ah(async (req, res) => {
    const s = await L.getSettings();
    const lvl = level(req.user, 'remote');
    res.json({
      level: lvl, canControl: atLeast(req.user, 'remote', 'control'), isAdmin: lvl === 'admin',
      allowSilent: lvl === 'admin' && s.allow_silent,
    });
  }));

  r.get('/downloads', (req, res) => res.json(listDownloads()));

  // Агенты (по технике или поиск)
  r.get('/agents', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.device) { params.push(intOrNull(req.query.device)); where.push(`a.device_id = $${params.length}`); }
    if (req.query.q) {
      params.push('%' + String(req.query.q).toLowerCase().slice(0, 100) + '%');
      where.push(`(lower(a.computer_name) LIKE $${params.length} OR lower(coalesce(a.windows_user, '')) LIKE $${params.length}
                  OR array_to_string(a.ips, ' ') LIKE $${params.length} OR lower(coalesce(d.inv_number, '')) LIKE $${params.length}
                  OR lower(coalesce(e.value, '')) LIKE $${params.length})`);
    }
    if (req.query.unbound === '1') where.push('a.device_id IS NULL');
    const { rows } = await L.query(
      `${L.AGENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY online DESC, lower(a.computer_name) LIMIT 500`, params);
    res.json(rows);
  }));

  // Начать подключение: выдаёт ссылку itremote:// для просмотрщика
  r.post('/sessions', ah(async (req, res) => {
    const b = req.body || {};
    const mode = b.mode === 'view' ? 'view' : 'control';
    if (mode === 'control' && !atLeast(req.user, 'remote', 'control')) throw new HttpError(403, 'Вам разрешён только просмотр');
    let a;
    if (b.agentId) {
      if (!UUID.test(String(b.agentId))) throw new HttpError(400, 'Неверный агент');
      a = (await L.query(`${L.AGENT_SELECT} WHERE a.id = $1`, [b.agentId])).rows[0];
    } else {
      const deviceId = intOrNull(b.deviceId);
      if (!deviceId) throw new HttpError(400, 'Не указан компьютер');
      a = (await L.query(`${L.AGENT_SELECT} WHERE a.device_id = $1 ORDER BY a.last_seen DESC LIMIT 1`, [deviceId])).rows[0];
    }
    if (!a) throw new HttpError(404, 'На этом компьютере не установлен агент удалённого доступа');
    if (!a.online) throw new HttpError(409, `Компьютер ${a.computer_name} не в сети (агент не отвечает)`);
    if (!a.fingerprint) throw new HttpError(409, 'Агент не сообщил сертификат — обновите агент');

    const settings = await L.getSettings();
    let consent = settings.consent;
    if (b.silent) {
      if (level(req.user, 'remote') !== 'admin' || !settings.allow_silent) throw new HttpError(403, 'Подключение без уведомления запрещено');
      consent = 'none';
    }
    // Заявка helpdesk, из которой подключаются (для истории заявки)
    const ticketId = intOrNull(b.ticketId);
    if (ticketId && level(req.user, 'helpdesk') === 'none') throw new HttpError(403, 'Нет доступа к заявкам');
    if (ticketId) {
      const t = await L.query('SELECT 1 FROM helpdesk.tickets WHERE id = $1', [ticketId]);
      if (!t.rows[0]) throw new HttpError(404, 'Заявка не найдена');
    }

    const id = crypto.randomUUID();
    const ticket = randomSecret();
    await L.query(
      `INSERT INTO remote.sessions (id, agent_id, computer_name, device_id, user_id, user_name, mode, consent, ticket_id,
                                    viewer_ticket_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))`,
      [id, a.id, a.computer_name, a.device_id, req.user.id, displayName(req.user), mode, consent, ticketId,
        sha256(ticket), Math.max(30, settings.token_ttl) + 60]);
    if (ticketId) {
      await L.query(
        `INSERT INTO helpdesk.history (ticket_id, user_id, action, details) VALUES ($1, $2, 'remote', $3)`,
        [ticketId, req.user.id, JSON.stringify({ computer: a.computer_name, mode, session: id })]);
    }
    const q = new URLSearchParams({ server: serverAddress(req), session: id, token: ticket });
    res.status(201).json({ id, url: 'itremote://connect?' + q.toString(), computerName: a.computer_name });
  }));

  // Журнал подключений: администратор видит все, остальные — свои
  r.get('/sessions', ah(async (req, res) => {
    const admin = level(req.user, 'remote') === 'admin';
    const where = [];
    const params = [];
    if (!admin) { params.push(req.user.id); where.push(`s.user_id = $${params.length}`); }
    if (req.query.agent && UUID.test(String(req.query.agent))) { params.push(req.query.agent); where.push(`s.agent_id = $${params.length}`); }
    if (req.query.device) { params.push(intOrNull(req.query.device)); where.push(`s.device_id = $${params.length}`); }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const { rows } = await L.query(
      `SELECT s.id, s.agent_id, s.computer_name, s.device_id, s.user_id, s.user_name, s.mode, s.consent, s.ticket_id,
              CASE WHEN s.status IN ('issued', 'opened') AND s.expires_at < now() - interval '5 minutes' THEN 'expired' ELSE s.status END AS status,
              s.viewer_ip, s.windows_user, s.detail, s.created_at, s.started_at, s.ended_at
         FROM remote.sessions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.created_at DESC LIMIT ${limit}`, params);
    res.json(rows);
  }));

  // Wake-on-LAN: «разбудить» выключенный компьютер по MAC из инвентаря или от агента
  r.post('/wake', ah(async (req, res) => {
    const deviceId = intOrNull((req.body || {}).deviceId);
    if (!deviceId) throw new HttpError(400, 'Не указан компьютер');
    const d = (await L.query('SELECT mac_address FROM public.devices WHERE id = $1', [deviceId])).rows[0];
    const agentMacs = (await L.query('SELECT macs FROM remote.agents WHERE device_id = $1', [deviceId])).rows.flatMap((r) => r.macs);
    const macs = [...new Set([L.normMac(d && d.mac_address), ...agentMacs].filter(Boolean))];
    if (!macs.length) throw new HttpError(400, 'Не известен MAC-адрес: заполните его в карточке техники');
    await Promise.all(macs.map(sendMagic));
    res.json({ ok: true, macs });
  }));

  // ---------- Администрирование ----------
  const admin = requireLevel('admin');

  r.get('/settings', admin, ah(async (req, res) => {
    const s = await L.getSettings();
    const k = await ensureKey(L.db);
    res.json({ ...s, server: serverAddress(req), key_fingerprint: k.fingerprint, downloads: listDownloads() });
  }));

  r.put('/settings', admin, ah(async (req, res) => {
    const b = req.body || {};
    if (b.consent !== undefined) {
      if (!['ask', 'notify'].includes(b.consent)) throw new HttpError(400, 'Неверный режим согласия');
      await L.setSetting('consent', b.consent);
    }
    if (b.allow_silent !== undefined) await L.setSetting('allow_silent', !!b.allow_silent);
    if (b.agent_port !== undefined) {
      const p = Number(b.agent_port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new HttpError(400, 'Порт — число от 1024 до 65535');
      await L.setSetting('agent_port', p);
    }
    if (b.token_ttl !== undefined) {
      const t = Number(b.token_ttl);
      if (!Number.isInteger(t) || t < 30 || t > 600) throw new HttpError(400, 'Срок действия пропуска — от 30 до 600 секунд');
      await L.setSetting('token_ttl', t);
    }
    res.json(await L.getSettings());
  }));

  r.post('/settings/registration-code', admin, ah(async (req, res) => {
    const code = L.newCode();
    await L.setSetting('registration_code', code);
    res.json({ registration_code: code });
  }));

  r.patch('/agents/:id', admin, ah(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new HttpError(400, 'Неверный агент');
    const deviceId = intOrNull((req.body || {}).deviceId);
    if (deviceId) {
      const d = await L.query('SELECT 1 FROM public.devices WHERE id = $1', [deviceId]);
      if (!d.rows[0]) throw new HttpError(404, 'Техника не найдена');
    }
    const { rowCount } = await L.query('UPDATE remote.agents SET device_id = $2, device_manual = TRUE WHERE id = $1', [req.params.id, deviceId]);
    if (!rowCount) throw new HttpError(404, 'Агент не найден');
    res.json({ ok: true });
  }));

  r.delete('/agents/:id', admin, ah(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new HttpError(400, 'Неверный агент');
    const { rowCount } = await L.query('DELETE FROM remote.agents WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Агент не найден');
    res.json({ ok: true });
  }));

  // ---------- Удалённая установка программы специалиста ----------
  // Специалисты — пользователи портала с доступом к удалённому доступу; к каждому — последняя установка
  r.get('/specialists', admin, ah(async (req, res) => {
    const { rows } = await L.query(
      `SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.username) AS name, u.username,
              CASE WHEN u.role = 'superadmin' THEN 'admin' ELSE u.modules->>'remote' END AS level,
              i.id AS install_id, i.computer, i.status, i.os, i.version, i.created_at AS installed_at, i.started_by_name
         FROM public.users u
         LEFT JOIN LATERAL (SELECT * FROM remote.installs WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) i ON TRUE
        WHERE u.is_active AND (u.role = 'superadmin' OR u.modules->>'remote' IN ('view', 'control', 'admin'))
        ORDER BY 2`);
    res.json(rows);
  }));

  r.get('/installs', admin, ah(async (req, res) => {
    const { rows } = await L.query(
      `SELECT id, user_id, user_name, computer, status, os, version, started_by_name, created_at, finished_at, steps
         FROM remote.installs ORDER BY created_at DESC LIMIT 100`);
    res.json(rows);
  }));

  r.get('/installs/:id', admin, ah(async (req, res) => {
    const { rows } = await L.query('SELECT * FROM remote.installs WHERE id = $1', [intOrNull(req.params.id)]);
    if (!rows[0]) throw new HttpError(404, 'Не найдено');
    res.json(rows[0]);
  }));

  r.post('/installs', admin, ah(async (req, res) => {
    const b = req.body || {};
    const userId = intOrNull(b.userId);
    const u = userId && (await L.query(
      `SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name FROM public.users WHERE id = $1 AND is_active`, [userId])).rows[0];
    if (!u) throw new HttpError(400, 'Выберите специалиста');
    const computer = String(b.computer || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(computer)) throw new HttpError(400, 'Укажите сетевое имя или IP-адрес компьютера');
    const adminUser = String(b.adminUser || '').trim();
    if (!adminUser || adminUser.length > 200 || /["\r\n]/.test(adminUser)) throw new HttpError(400, 'Укажите учётную запись администратора (ДОМЕН\\имя)');
    const password = String(b.password || '');
    if (!password || password.length > 256) throw new HttpError(400, 'Укажите пароль администратора');
    const id = await require('./install').startInstall({
      specialist: u, computer, adminUser, password, server: serverAddress(req),
      startedBy: { id: req.user.id, name: displayName(req.user) },
    });
    res.status(202).json({ id });
  }));

  return r;
}

// Скачивание: файлы, положенные в public/remote/downloads при установке обновления
function listDownloads() {
  try {
    return fs.readdirSync(DOWNLOADS).filter((f) => /\.(exe|msi|zip)$/i.test(f))
      .map((f) => ({ name: f, size: fs.statSync(path.join(DOWNLOADS, f)).size }));
  } catch {
    return [];
  }
}

/** Пакет Wake-on-LAN: 6×FF и 16 повторов MAC, широковещательно на порт 9 */
function sendMagic(mac) {
  const m = Buffer.from(mac, 'hex');
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { s.close(); resolve(); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(pkt, 9, '255.255.255.255', () => { s.close(); resolve(); });
    });
  });
}

module.exports = { apiRouter, migrate: L.migrate, agentRouter: () => require('./agent-api').router() };
