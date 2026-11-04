// Администрирование портала: пользователи и их доступ к модулям (только суперадмин)
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../inventory/db');
const { requireSuperadmin } = require('../inventory/access');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');
const { MODULES, DOC_TYPES, normalizeModules } = require('./modules');
const { syncUser, removeUser } = require('./sync');

const router = express.Router();
router.use(requireSuperadmin);

const FIELDS = 'id, username, full_name, email, role, is_active, permissions, modules, created_at, last_login';
// Права читателя инвентаря по умолчанию — видит всё, кроме паролей
const DEFAULT_READER = { types: null, departments: null, fields: null, passwords: false, software: true, export: true };

const roleFor = (isAdmin, modules) => (isAdmin ? 'superadmin' : modules.inventory === 'edit' ? 'editor' : 'reader');

router.get('/meta', (req, res) => {
  res.json({
    modules: Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, { label: m.label, levels: m.levels }])),
    docTypes: DOC_TYPES,
  });
});

router.get('/users', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ${FIELDS} FROM users ORDER BY (role = 'superadmin') DESC, lower(coalesce(full_name, username))`);
  res.json(rows);
}));

function validEmail(email) {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Некорректный e-mail');
  return email;
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
  res.status(201).json(rows[0]);
}));

router.put('/users/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  if (id === req.user.id && (!b.is_admin || b.is_active === false)) {
    throw new HttpError(400, 'Нельзя снять права администратора или отключить собственную учётную запись');
  }
  const modules = normalizeModules(b.modules);
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
  res.json(rows[0]);
}));

router.delete('/users/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Нельзя удалить собственную учётную запись');
  await query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [id]);
  await removeUser(id);
  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Пользователь не найден');
  res.json({ ok: true });
}));

module.exports = router;
