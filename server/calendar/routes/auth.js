import { Router } from 'express';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { ah, validate } from '../validate.js';

const require = createRequire(import.meta.url);
const { changePassword } = require('../../portal/auth.js');
const { syncUser } = require('../../portal/sync.js');
const { poolFor } = require('../../db.js');

const r = Router();

r.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ФИО хранится на портале, должность и цвет — в календаре
r.patch('/me', requireAuth, ah(async (req, res) => {
  const data = validate(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      position: z.string().trim().max(100).nullable().optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }),
    req.body
  );
  if (data.name) {
    const { rows } = await poolFor('public').query(
      `UPDATE users SET full_name = $2 WHERE id = $1
       RETURNING id, username, full_name, email, role, is_active, modules`, [req.user.id, data.name]);
    await syncUser(rows[0]);
  }
  const { rows } = await query(
    `UPDATE users SET
       position = CASE WHEN $2::boolean THEN $3 ELSE position END,
       color = COALESCE($4, color)
     WHERE id = $1
     RETURNING id, email, name, position, color`,
    [req.user.id, 'position' in data, data.position ?? null, data.color ?? null]
  );
  res.json({ user: { ...req.user, ...rows[0] } });
}));

r.post('/change-password', requireAuth, ah(async (req, res) => {
  await changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
  res.json({ ok: true });
}));

export default r;
