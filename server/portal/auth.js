// Вход, выход, профиль и смена пароля — единые для всех модулей портала
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../inventory/db');
const { requireAuth } = require('../inventory/access');
const { HttpError, ah, str } = require('../inventory/util');
const { summary, MODULES } = require('./modules');
const { syncUser } = require('./sync');

const router = express.Router();

// Защита от перебора паролей: 10 неудачных попыток за 15 минут с одного IP
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function tooMany(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW) { attempts.delete(ip); return false; }
  return a.count >= 10;
}
function fail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
}

/** Смена пароля (используется также модулями «Документы» и «Календарь») */
async function changePassword(userId, current, next) {
  if (!next || String(next).length < 8) throw new HttpError(400, 'Новый пароль должен быть не короче 8 символов');
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    throw new HttpError(400, 'Текущий пароль указан неверно');
  }
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(next), 10), userId]);
}

// Публичные настройки для страницы входа
router.get('/config', (req, res) => {
  res.json({ helpdeskUrl: process.env.HELPDESK_URL || null, helpdeskPort: Number(process.env.HELPDESK_PORT || 3100) });
});

router.post('/login', ah(async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) throw new HttpError(429, 'Слишком много попыток входа. Попробуйте через 15 минут');
  const { username, password } = req.body || {};
  if (!username || !password) throw new HttpError(400, 'Введите логин и пароль');
  // Входить можно по логину или по e-mail
  const { rows } = await query(
    `SELECT id, password_hash, is_active FROM users
      WHERE lower(username) = lower($1) OR (position('@' in $1) > 0 AND lower(email) = lower($1))
      ORDER BY (lower(username) = lower($1)) DESC LIMIT 1`, [String(username).trim()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(password), u.password_hash))) {
    fail(ip);
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  if (!u.is_active) throw new HttpError(403, 'Учётная запись отключена');
  attempts.delete(ip);
  await new Promise((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
  req.session.userId = u.id;
  await query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('itdb.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  const { id, username, full_name, email, role } = req.user;
  res.json({
    user: { id, username, full_name, email, role, isAdmin: role === 'superadmin' },
    access: summary(req.user),
    modules: Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, m.label])),
    helpdeskUrl: process.env.HELPDESK_URL || null,
    helpdeskPort: Number(process.env.HELPDESK_PORT || 3100),
  });
});

router.patch('/me', requireAuth, ah(async (req, res) => {
  const fullName = str(req.body.full_name, 200);
  const email = str(req.body.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Некорректный e-mail');
  const { rows } = await query(
    `UPDATE users SET full_name = $2, email = $3 WHERE id = $1
     RETURNING id, username, full_name, email, role, is_active, modules`, [req.user.id, fullName, email]);
  await syncUser(rows[0]);
  res.json({ ok: true });
}));

router.post('/password', requireAuth, ah(async (req, res) => {
  const { current, next } = req.body || {};
  await changePassword(req.user.id, current, next);
  res.json({ ok: true });
}));

module.exports = { router, changePassword };
