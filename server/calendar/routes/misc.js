import { Router } from 'express';
import { query } from '../db.js';
import { requireRole } from '../auth.js';
import { ah } from '../validate.js';

const r = Router();

// Сводка для дашборда
r.get('/stats', ah(async (req, res) => {
  const [byStatus, overdue, mine, today, workload] = await Promise.all([
    query('SELECT status, count(*)::int AS n FROM tasks GROUP BY status'),
    query("SELECT count(*)::int AS n FROM tasks WHERE end_at < now() AND status IN ('todo','in_progress')"),
    query(`SELECT count(*)::int AS n FROM tasks t JOIN task_assignees a ON a.task_id=t.id
           WHERE a.user_id=$1 AND t.status IN ('todo','in_progress')`, [req.user.id]),
    query(`SELECT count(*)::int AS n FROM tasks WHERE start_at < date_trunc('day', now()) + interval '1 day'
           AND end_at >= date_trunc('day', now()) AND status <> 'cancelled'`),
    query(`SELECT u.id, u.name, u.color,
             count(t.id) FILTER (WHERE t.status IN ('todo','in_progress'))::int AS open,
             count(t.id) FILTER (WHERE t.status IN ('todo','in_progress') AND t.end_at < now())::int AS overdue,
             count(t.id) FILTER (WHERE t.status = 'done' AND t.updated_at > now() - interval '30 days')::int AS done_30d
           FROM users u
           LEFT JOIN task_assignees a ON a.user_id = u.id
           LEFT JOIN tasks t ON t.id = a.task_id
           WHERE u.is_active
           GROUP BY u.id ORDER BY open DESC, u.name`),
  ]);
  res.json({
    byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
    overdue: overdue.rows[0].n,
    mineOpen: mine.rows[0].n,
    today: today.rows[0].n,
    workload: workload.rows,
  });
}));

// Журнал действий: редакторы и администраторы
r.get('/activity', requireRole('editor'), ah(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.name AS user_name, u.color AS user_color
     FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC LIMIT $1`, [limit]);
  res.json({ activity: rows });
}));

export default r;
