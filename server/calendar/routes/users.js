import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../validate.js';

const r = Router();

// Сотрудники портала — для назначения исполнителей и фильтров. Исполнителем можно выбрать
// любого активного сотрудника, в том числе без доступа к календарю (has_access = false).
// Учётными записями управляет администратор портала.
r.get('/', ah(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await query(
    `SELECT ${isAdmin ? 'id, email, name, role, position, color, is_active, has_access, last_login_at, created_at' : 'id, name, role, position, color, is_active, has_access'}
       FROM users WHERE NOT is_system ORDER BY is_active DESC, has_access DESC, name`
  );
  res.json({ users: rows });
}));

export default r;
