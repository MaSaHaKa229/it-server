import { Router } from 'express';
import { createRequire } from 'node:module';
import { query, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { ah } from '../validate.js';
import { taskCond } from '../scope.js';

const { trackChanges } = createRequire(import.meta.url)('../../portal/audit.js'); // журнал действий администраторов

const r = Router();

// Сводка для дашборда
r.get('/stats', ah(async (req, res) => {
  // Считаются только задачи, которые пользователю разрешено видеть
  const sv = [];
  const sc = taskCond(req.user, sv) || 'TRUE';
  const wv = [];
  const wc = taskCond(req.user, wv) || 'TRUE';
  const [byStatus, overdue, mine, today, workload] = await Promise.all([
    query(`SELECT status, count(*)::int AS n FROM tasks t WHERE ${sc} GROUP BY status`, sv),
    query(`SELECT count(*)::int AS n FROM tasks t WHERE end_at < now() AND status IN ('todo','in_progress') AND ${sc}`, sv),
    query(`SELECT count(*)::int AS n FROM tasks t JOIN task_assignees a ON a.task_id=t.id
           WHERE a.user_id=$1 AND t.status IN ('todo','in_progress')`, [req.user.id]),
    query(`SELECT count(*)::int AS n FROM tasks t WHERE start_at < date_trunc('day', now()) + interval '1 day'
           AND end_at >= date_trunc('day', now()) AND status <> 'cancelled' AND ${sc}`, sv),
    query(`SELECT u.id, u.name, u.color,
             count(t.id) FILTER (WHERE t.status IN ('todo','in_progress'))::int AS open,
             count(t.id) FILTER (WHERE t.status IN ('todo','in_progress') AND t.end_at < now())::int AS overdue,
             count(t.id) FILTER (WHERE t.status = 'done' AND t.updated_at > now() - interval '30 days')::int AS done_30d
           FROM users u
           LEFT JOIN task_assignees a ON a.user_id = u.id
           LEFT JOIN tasks t ON t.id = a.task_id AND ${wc}
           WHERE u.is_active AND NOT u.is_system
           GROUP BY u.id ORDER BY open DESC, u.name`, wv),
  ]);
  res.json({
    byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
    overdue: overdue.rows[0].n,
    mineOpen: mine.rows[0].n,
    today: today.rows[0].n,
    workload: workload.rows,
  });
}));

// Цвета календаря: видят все, меняет администратор календаря.
// { absence: {vacation: '#..', ...}, priority: {...}, status: {...} } — только заданные значения
const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_GROUPS = {
  absence: ['vacation', 'sick', 'trip', 'dayoff', 'other'],
  priority: ['low', 'normal', 'high', 'critical'],
  status: ['todo', 'in_progress', 'done', 'cancelled'],
};
r.get('/settings/colors', ah(async (req, res) => {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'colors'");
  res.json({ colors: rows[0]?.value || {} });
}));
r.put('/settings/colors', requireRole('admin'), trackChanges([[/colors$/, 'calendar_colors']]), ah(async (req, res) => {
  const src = req.body?.colors || {};
  const out = {};
  for (const [g, keys] of Object.entries(COLOR_GROUPS)) {
    out[g] = {};
    for (const k of keys) if (HEX.test(src[g]?.[k] || '')) out[g][k] = src[g][k];
  }
  await query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('colors', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(out), req.user.id]);
  await logActivity({ query }, req.user.id, 'update', 'settings', null, { name: 'цвета календаря' });
  res.json({ colors: out });
}));

// Журнал действий: редакторы и администраторы
r.get('/activity', requireRole('editor'), ah(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, CASE WHEN u.is_system THEN 'Служба ИТ' ELSE u.name END AS user_name,
            CASE WHEN u.is_system THEN '#5E6C84' ELSE u.color END AS user_color
     FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC LIMIT $1`, [limit]);
  res.json({ activity: rows });
}));

export default r;
