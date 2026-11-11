const express = require('express');
const { query } = require('../db');
const { requireSuperadmin } = require('../access');
const { HttpError, ah, intOrNull } = require('../util');

const router = express.Router();
router.use(requireSuperadmin);

function normalizePermissions(p) {
  p = p && typeof p === 'object' ? p : {};
  const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : null);
  return {
    types: p.types === null ? null : ids(p.types) || [],
    departments: p.departments === null || p.departments === undefined ? null : ids(p.departments),
    fields: p.fields === null || p.fields === undefined ? null
      : (Array.isArray(p.fields) ? p.fields.map(String).slice(0, 500) : null),
    passwords: !!p.passwords,
    software: !!p.software,
    export: p.export !== false,
  };
}

// Учётные записи создаются и удаляются в разделе «Администрирование» портала.
// Здесь суперадмин настраивает только роль в инвентаре и права читателя.
router.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, full_name, email, role, is_active, permissions, created_at, last_login
       FROM users WHERE role = 'superadmin' OR coalesce(modules->>'inventory', 'none') <> 'none'
      ORDER BY role, username`);
  res.json(rows);
}));

router.post('/', (req, res) => {
  res.status(400).json({ error: 'Пользователи создаются на главной странице портала: «Администрирование»' });
});

router.put('/:id', require('../../portal/audit').trackChanges([[/^\/\d+$/, 'inventory_user']]), ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body;
  const cur = (await query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
  if (!cur) throw new HttpError(404, 'Пользователь не найден');
  if (cur.role === 'superadmin' || b.role === 'superadmin') {
    throw new HttpError(400, 'Права администратора портала меняются в разделе «Администрирование»');
  }
  if (!['editor', 'reader'].includes(b.role)) throw new HttpError(400, 'Неизвестная роль');
  await query(
    `UPDATE users SET role = $1, permissions = $2,
            modules = modules || jsonb_build_object('inventory', $3::text) WHERE id = $4`,
    [b.role, JSON.stringify(normalizePermissions(b.permissions)), b.role === 'editor' ? 'edit' : 'view', id]);
  res.json({ ok: true });
}));

router.delete('/:id', (req, res) => {
  res.status(400).json({ error: 'Пользователи удаляются на главной странице портала: «Администрирование»' });
});

module.exports = router;
