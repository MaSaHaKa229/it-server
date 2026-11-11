// Авторизация через портал: пользователь берётся из общей сессии,
// роль в календаре вычисляется из его прав на модуль «Задачи и календарь».
import { createRequire } from 'node:module';
import { query } from './db.js';

const require = createRequire(import.meta.url);
const { level } = require('../portal/modules.js');
const { syncUser, calRole } = require('../portal/sync.js');

export async function requireAuth(req, res, next) {
  try {
    const u = req.portalUser || req.user;
    if (!u) return res.status(401).json({ error: 'Требуется вход' });
    if (level(u, 'calendar') === 'none') return res.status(403).json({ error: 'Нет доступа к разделу «Задачи и календарь»' });
    await syncUser(u);
    const { rows } = await query('SELECT id, email, name, position, color, is_system FROM users WHERE id = $1', [u.id]);
    if (!rows[0]) return res.status(401).json({ error: 'Сессия недействительна' });
    req.portalUser = u;
    const role = calRole(u);
    req.user = {
      ...rows[0],
      role,
      is_active: true,
      // «Видит только свои задачи» — ограничение для наблюдателей и редакторов
      own_only: role !== 'admin' && !!(u.modules && u.modules.calendar_own_only),
    };
    next();
  } catch (e) {
    next(e);
  }
}

const RANK = { viewer: 1, editor: 2, admin: 3 };

export const requireRole = (minRole) => (req, res, next) => {
  if (RANK[req.user.role] >= RANK[minRole]) return next();
  res.status(403).json({ error: 'Недостаточно прав' });
};
