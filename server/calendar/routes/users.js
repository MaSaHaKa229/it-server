import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../validate.js';

const r = Router();

// Сотрудники с доступом к календарю — для назначения исполнителей и фильтров.
// Учётными записями управляет администратор портала.
r.get('/', ah(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await query(
    `SELECT ${isAdmin ? 'id, email, name, role, position, color, is_active, last_login_at, created_at' : 'id, name, role, position, color, is_active'}
       FROM users ORDER BY is_active DESC, name`
  );
  res.json({ users: rows });
}));

export default r;
