// Администрирование портала: пользователи и их доступ к модулям (только суперадмин)
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../inventory/db');
const { requireSuperadmin } = require('../inventory/access');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');
const { MODULES, normalizeModules } = require('./modules');
const { syncUser, removeUser } = require('./sync');

const audit = require('./audit');
const router = express.Router();
router.use(requireSuperadmin);

const FIELDS = 'id, username, full_name, email, role, is_active, permissions, modules, created_at, last_login';
// Права читателя инвентаря по умолчанию — видит всё, кроме паролей
const DEFAULT_READER = { types: null, departments: null, fields: null, passwords: false, software: true, export: true };

const roleFor = (isAdmin, modules) => (isAdmin ? 'superadmin' : modules.inventory === 'edit' ? 'editor' : 'reader');

router.get('/meta', ah(async (req, res) => {
  // Виды документов — из справочника реестра документов
  const { rows } = await query('SELECT code, name FROM docs.doc_types ORDER BY sort, name');
  // Папки документов (дерево) — для выдачи доступа по папкам
  const folders = (await require('../docs/routes/folders').loadTree()).map((f) => ({ id: f.id, name: f.name, path: f.path, depth: f.depth, parent_id: f.parent_id }));
  // Категории задач и сотрудники календаря — для настройки уровня «Просмотр»
  const calCategories = (await query('SELECT id, name, color FROM calendar.categories ORDER BY name')).rows;
  const calPeople = (await query('SELECT id, name FROM calendar.users WHERE is_active AND NOT is_system ORDER BY name')).rows;
  res.json({
    calCategories,
    calPeople,
    modules: Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, { label: m.label, levels: m.levels }])),
    docTypes: Object.fromEntries(rows.map((r) => [r.code, r.name])),
    docFolders: folders,
  });
}));

router.get('/users', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ${FIELDS} FROM users ORDER BY (role = 'superadmin') DESC, lower(coalesce(full_name, username))`);
  res.json(rows);
}));

function validEmail(email) {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Некорректный e-mail');
  return email;
}

/** Что изменилось у пользователя — для журнала */
function diffUser(a, b, password) {
  const out = { username: b.username };
  if (!a) return out;
  if (a.role !== b.role) out.role = [a.role, b.role];
  if (a.is_active !== b.is_active) out.is_active = [a.is_active, b.is_active];
  if ((a.full_name || '') !== (b.full_name || '')) out.full_name = [a.full_name, b.full_name];
  if ((a.email || '') !== (b.email || '')) out.email = [a.email, b.email];
  const am = a.modules || {};
  const bm = b.modules || {};
  const mods = {};
  for (const k of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    if (JSON.stringify(am[k] ?? null) !== JSON.stringify(bm[k] ?? null)) mods[k] = [am[k] ?? null, bm[k] ?? null];
  }
  if (Object.keys(mods).length) out.modules = mods;
  if (password) out.password = 'изменён';
  return out;
}

router.post('/users', ah(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username, 100);
  if (!username || !/^[\w.@-]+$/.test(username)) throw new HttpError(400, 'Логин: латиница, цифры, точка, дефис, @');
  if (!b.password || String(b.password).length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
  const exists = await query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  if (exists.rows[0]) throw new HttpError(409, 'Пользователь с таким логином уже существует');
  const modules = normalizeModules(b.modules);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, email, role, is_active, permissions, modules)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${FIELDS}`,
    [username, await bcrypt.hash(String(b.password), 10), str(b.full_name, 200), validEmail(str(b.email, 200)),
      roleFor(!!b.is_admin, modules), b.is_active !== false, JSON.stringify(DEFAULT_READER), JSON.stringify(modules)]);
  await syncUser(rows[0]);
  await audit.log(req, 'user_created', rows[0].full_name || rows[0].username, { username: rows[0].username, role: rows[0].role, modules });
  res.status(201).json(rows[0]);
}));

router.put('/users/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  if (id === req.user.id && (!b.is_admin || b.is_active === false)) {
    throw new HttpError(400, 'Нельзя снять права администратора или отключить собственную учётную запись');
  }
  const modules = normalizeModules(b.modules);
  const before = (await query(`SELECT ${FIELDS} FROM users WHERE id = $1`, [id])).rows[0];
  const params = [str(b.full_name, 200), validEmail(str(b.email, 200)), roleFor(!!b.is_admin, modules),
    b.is_active !== false, JSON.stringify(modules), id];
  let pw = '';
  if (b.password) {
    if (String(b.password).length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
    params.push(await bcrypt.hash(String(b.password), 10));
    pw = `, password_hash = $${params.length}`;
  }
  const { rows } = await query(
    `UPDATE users SET full_name = $1, email = $2, role = $3, is_active = $4, modules = $5${pw}
      WHERE id = $6 RETURNING ${FIELDS}`, params);
  if (!rows[0]) throw new HttpError(404, 'Пользователь не найден');
  if (b.is_active === false) await query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [id]);
  await syncUser(rows[0]);
  await audit.log(req, 'user_updated', rows[0].full_name || rows[0].username, diffUser(before, rows[0], !!b.password));
  res.json(rows[0]);
}));

router.delete('/users/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Нельзя удалить собственную учётную запись');
  await query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [id]);
  await removeUser(id);
  const { rows: del } = await query('DELETE FROM users WHERE id = $1 RETURNING username, full_name', [id]);
  if (!del[0]) throw new HttpError(404, 'Пользователь не найден');
  await audit.log(req, 'user_deleted', del[0].full_name || del[0].username, { username: del[0].username });
  res.json({ ok: true });
}));

// ---------------- Резервные копии ----------------
router.use('/backup', require('./backup').router);

// ---------------- Почта ----------------
const mail = require('./mail');
router.get('/settings/mail', ah(async (req, res) => res.json(await mail.settingsView())));
router.put('/settings/mail', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.disabled && b.host && !/^[\w.-]+$/.test(String(b.host).trim())) throw new HttpError(400, 'Адрес SMTP-сервера: имя или IP без «http://»');
  await mail.save(b);
  await audit.log(req, 'mail_settings', null, { host: b.host || '', port: b.port, user: b.user || '', disabled: !!b.disabled, password: typeof b.pass === 'string' ? 'изменён' : undefined });
  res.json(await mail.settingsView());
}));
router.post('/settings/mail/test', ah(async (req, res) => {
  const to = str((req.body || {}).to, 200);
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'Укажите e-mail для проверочного письма');
  try {
    await mail.test(to);
  } catch (e) {
    throw new HttpError(400, 'Письмо не отправлено: ' + e.message);
  }
  res.json({ ok: true });
}));

// ---------------- Пороги уведомлений ----------------
const N = require('./notify');
router.get('/settings/notify', ah(async (req, res) => res.json(await N.thresholds())));
router.put('/settings/notify', ah(async (req, res) => {
  const b = req.body || {};
  const num = (v, min, max, def) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  const v = {
    warranty_days: num(b.warranty_days, 1, 365, 30),
    offline_days: num(b.offline_days, 1, 365, 30),
    hd_due_hours: num(b.hd_due_hours, 1, 240, 24),
    audit_days: Math.min(30, Math.max(0, Math.round(Number(b.audit_days)) || 0)),
  };
  await query(`INSERT INTO portal_settings (key, value) VALUES ('notify', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  await audit.log(req, 'notify_settings', null, v);
  res.json(v);
}));

// ---------------- Журнал входов и действий ----------------
router.get('/audit', ah(async (req, res) => {
  const q = req.query;
  const where = [];
  const vals = [];
  const p = (v) => { vals.push(v); return '$' + vals.length; };
  if (q.action === 'logins') where.push(`a.action IN ('login', 'login_failed', 'logout')`);
  else if (q.action === 'failed') where.push(`a.action = 'login_failed'`);
  else if (q.action === 'admin') where.push(`a.action NOT IN ('login', 'login_failed', 'logout', 'password_changed')`);
  else if (q.action) where.push(`a.action = ${p(String(q.action))}`);
  if (q.user) where.push(`a.user_id = ${p(Number(q.user) || 0)}`);
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) where.push(`a.at >= ${p(q.from)}::date`);
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) where.push(`a.at < ${p(q.to)}::date + 1`);
  if (q.q) {
    const like = p(`%${String(q.q).slice(0, 100)}%`);
    where.push(`(a.object ILIKE ${like} OR a.username ILIKE ${like} OR u.full_name ILIKE ${like} OR a.details::text ILIKE ${like} OR a.ip ILIKE ${like})`);
  }
  const limit = Math.min(500, Number(q.limit) || 200);
  const offset = Math.max(0, Number(q.offset) || 0);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [list, total] = await Promise.all([
    query(`SELECT a.id, a.at, a.user_id, COALESCE(NULLIF(u.full_name, ''), u.username, a.username) AS user_name, a.username,
                  a.action, a.object, a.details, a.ip
             FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}
            ORDER BY a.at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`, vals),
    query(`SELECT count(*)::int AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}`, vals),
  ]);
  res.json({ items: list.rows, total: total.rows[0].n, actions: audit.ACTIONS });
}));

module.exports = router;
