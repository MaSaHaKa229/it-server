// Краткая сводка для плиток главной страницы
const express = require('express');
const { query } = require('../inventory/db');
const { requireAuth } = require('../inventory/access');
const { ah } = require('../inventory/util');
const { level } = require('./modules');

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
    out.calendar = await safe(async () => (await query(
      `SELECT count(*) FILTER (WHERE a.user_id IS NOT NULL AND t.status IN ('todo','in_progress'))::int AS mine,
              count(*) FILTER (WHERE t.start_at < date_trunc('day', now()) + interval '1 day'
                                 AND t.end_at >= date_trunc('day', now()) AND t.status <> 'cancelled')::int AS today
         FROM calendar.tasks t
         LEFT JOIN calendar.task_assignees a ON a.task_id = t.id AND a.user_id = $1`, [u.id])).rows[0]);
  }
  if (level(u, 'helpdesk') !== 'none') {
    out.helpdesk = await safe(async () => (await query(
      `SELECT count(*) FILTER (WHERE NOT s.is_closed)::int AS open,
              count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id = $1)::int AS mine,
              count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE NOT s.is_closed AND t.due_at < now())::int AS overdue
         FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id`, [u.id])).rows[0]);
  }
  res.json(out);
}));

module.exports = router;
