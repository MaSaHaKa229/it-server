// Краткая сводка для плиток главной страницы
const express = require('express');
const { query } = require('../inventory/db');
const { requireAuth } = require('../inventory/access');
const { ah } = require('../inventory/util');
const { level } = require('./modules');
const { calRole } = require('./sync');

const router = express.Router();

const safe = async (fn) => { try { return await fn(); } catch { return null; } };

router.get('/', requireAuth, ah(async (req, res) => {
  const u = req.user;
  const out = {};
  if (level(u, 'inventory') === 'edit') {
    out.inventory = await safe(async () => (await query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'broken')::int AS broken FROM devices`)).rows[0]);
  }
  if (level(u, 'docs') !== 'none') {
    const types = u.role !== 'superadmin' && Array.isArray(u.modules?.docs_types) && u.modules.docs_types.length
      ? u.modules.docs_types : null;
    out.docs = await safe(async () => (await query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int AS recent
         FROM docs.documents WHERE ($1::text[] IS NULL OR doc_type = ANY($1::text[]))
          AND ($2::int[] IS NULL OR folder_id = ANY($2::int[]))`,
      [types, await require('../docs/access').allowedFolderIds(u)])).rows[0]);
  }
  if (level(u, 'calendar') !== 'none') {
    out.calendar = await safe(async () => {
      // Только задачи, которые пользователю разрешено видеть (как в самом календаре)
      const { scopeOf, taskCond } = await import('../calendar/scope.js');
      const vals = [u.id];
      const cond = (taskCond({ id: u.id, scope: scopeOf(u, calRole(u)) }, vals) || 'TRUE')
        .replace(/task_assignees/g, 'calendar.task_assignees');
      return (await query(
        `SELECT count(*) FILTER (WHERE a.user_id IS NOT NULL AND t.status IN ('todo','in_progress'))::int AS mine,
                count(*) FILTER (WHERE t.start_at < date_trunc('day', now()) + interval '1 day'
                                   AND t.end_at >= date_trunc('day', now()) AND t.status <> 'cancelled')::int AS today
           FROM calendar.tasks t
           LEFT JOIN calendar.task_assignees a ON a.task_id = t.id AND a.user_id = $1
          WHERE ${cond}`, vals)).rows[0];
    });
  }
  if (level(u, 'helpdesk') !== 'none') {
    out.helpdesk = await safe(async () => (await query(
      `SELECT count(*) FILTER (WHERE NOT s.is_closed)::int AS open,
              count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id = $1)::int AS mine,
              count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE NOT s.is_closed AND t.due_at < now())::int AS overdue
         FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id`, [u.id])).rows[0]);
  }
  if (level(u, 'remote') !== 'none') {
    out.remote = await safe(async () => (await query(
      `SELECT (SELECT count(*)::int FROM remote.agents WHERE last_seen > now() - interval '90 seconds') AS online,
              (SELECT count(*)::int FROM remote.sessions WHERE created_at >= date_trunc('day', now())
                 AND status NOT IN ('issued') AND ($1::int IS NULL OR user_id = $1)) AS today`,
      [level(u, 'remote') === 'admin' ? null : u.id])).rows[0]);
  }
  res.json(out);
}));

// Сводка «моё» для главной страницы: мои открытые заявки, мои задачи на сегодня (и просроченные)
router.get('/my', requireAuth, ah(async (req, res) => {
  const u = req.user;
  const out = { tickets: null, tasks: null };
  if (['executor', 'admin'].includes(level(u, 'helpdesk'))) {
    out.tickets = await safe(async () => (await query(
      `SELECT t.id, t.title, t.priority, t.due_at, t.created_at, s.name AS status, s.color AS status_color,
              r.full_name AS requester, (t.due_at IS NOT NULL AND t.due_at < now()) AS overdue
         FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id JOIN helpdesk.requesters r ON r.id = t.requester_id
        WHERE t.assignee_id = $1 AND NOT s.is_closed
        ORDER BY (t.due_at IS NOT NULL AND t.due_at < now()) DESC, t.due_at NULLS LAST,
                 array_position(ARRAY['critical','high','normal','low'], t.priority), t.created_at
        LIMIT 50`, [u.id])).rows);
  }
  if (level(u, 'calendar') !== 'none') {
    out.tasks = await safe(async () => (await query(
      `SELECT t.id, t.title, t.start_at, t.end_at, t.all_day, t.status, t.priority, c.name AS category, c.color AS category_color,
              ((CASE WHEN t.all_day THEN t.end_at + interval '1 day' ELSE t.end_at END) < now()) AS overdue
         FROM calendar.tasks t JOIN calendar.task_assignees a ON a.task_id = t.id AND a.user_id = $1
         LEFT JOIN calendar.categories c ON c.id = t.category_id
        WHERE t.status IN ('todo', 'in_progress')
          AND t.start_at < date_trunc('day', now()) + interval '1 day'
        ORDER BY ((CASE WHEN t.all_day THEN t.end_at + interval '1 day' ELSE t.end_at END) < now()) DESC, t.start_at
        LIMIT 50`, [u.id])).rows);
  }
  res.json(out);
}));

module.exports = router;
