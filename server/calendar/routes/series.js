// Периодические задачи (серии): список, просмотр, изменение, удаление
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { ah, validate, HttpError } from '../validate.js';
import { ensureOccurrences, EVERY, validTz } from '../series.js';

const r = Router();

const SELECT = `
  SELECT s.id, s.title, s.description, s.start_at, s.end_at, s.all_day, s.priority, s.category_id, s.every_months, s.color,
         to_char(s.until, 'YYYY-MM-DD') AS until, s.assignees AS assignee_ids, s.checklist, s.created_at, s.updated_at,
         c.name AS category_name, c.color AS category_color, cu.name AS created_by_name,
         COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.color) ORDER BY u.name)
           FROM users u WHERE u.id = ANY(s.assignees)), '[]') AS assignees,
         (SELECT json_build_object('id', t.id, 'start_at', t.start_at, 'end_at', t.end_at, 'status', t.status)
            FROM tasks t WHERE t.series_id = s.id AND t.status IN ('todo', 'in_progress')
           ORDER BY t.start_at LIMIT 1) AS next,
         (SELECT count(*)::int FROM tasks t WHERE t.series_id = s.id AND t.status = 'done') AS done_count,
         (SELECT count(*)::int FROM tasks t WHERE t.series_id = s.id AND t.status IN ('todo', 'in_progress')
             AND (CASE WHEN t.all_day THEN t.end_at + interval '1 day' ELSE t.end_at END) < now()) AS overdue_count
    FROM task_series s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN users cu ON cu.id = s.created_by`;

// «Только свои задачи»: серии, которые пользователь создал или в которых он исполнитель
const own = (user, n) => (user.own_only ? `(s.created_by = $${n} OR $${n} = ANY(s.assignees))` : 'TRUE');

r.get('/', ah(async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE ${own(req.user, 1)} ORDER BY s.title`, req.user.own_only ? [req.user.id] : []);
  res.json({ series: rows });
}));

async function getSeries(id, user) {
  const vals = [id];
  if (user.own_only) vals.push(user.id);
  const { rows } = await query(`${SELECT} WHERE s.id = $1 AND ${own(user, 2)}`, vals);
  if (!rows[0]) throw new HttpError(404, 'Периодическая задача не найдена');
  return rows[0];
}

r.get('/:id', ah(async (req, res) => {
  res.json({ series: await getSeries(Number(req.params.id), req.user) });
}));

const body = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(200),
  description: z.string().max(10000).default(''),
  start_at: z.coerce.date(),
  end_at: z.coerce.date(),
  all_day: z.boolean().default(false),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  category_id: z.number().int().nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  freq: z.enum(Object.keys(EVERY)),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignees: z.array(z.number().int()).default([]),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300) })).default([]),
  tz: z.string().max(64).optional(),
}).refine((d) => d.end_at >= d.start_at, { message: 'Окончание не может быть раньше начала', path: ['end_at'] });

// Изменение серии касается будущих повторов, к которым ещё не приступали (статус «К выполнению»).
// Начатые, выполненные и прошедшие повторы не меняются.
r.patch('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const old = await getSeries(id, req.user);
  const d = validate(body, req.body);
  const every = EVERY[d.freq];
  const assignees = [...new Set(d.assignees)];
  const timingChanged = new Date(old.start_at).getTime() !== d.start_at.getTime() || new Date(old.end_at).getTime() !== d.end_at.getTime()
    || old.all_day !== d.all_day || old.every_months !== every || (old.until || null) !== (d.until || null);

  await withTransaction(async (db) => {
    await db.query(
      `UPDATE task_series SET title=$2, description=$3, start_at=$4, end_at=$5, all_day=$6, priority=$7, category_id=$8,
              every_months=$9, until=$10, assignees=$11, checklist=$12, updated_by=$13, updated_at=now(),
              tz=COALESCE($14, tz), color=$15 WHERE id=$1`,
      [id, d.title, d.description, d.start_at, d.end_at, d.all_day, d.priority, d.category_id ?? null, every,
        d.until || null, assignees, JSON.stringify(d.checklist), req.user.id, d.tz ? await validTz(db, d.tz) : null, d.color ?? null]);
    const future = `series_id = $1 AND status = 'todo' AND start_at >= date_trunc('day', now())`;
    if (timingChanged) {
      // Даты изменились — будущие повторы создаются заново
      await db.query(`DELETE FROM tasks WHERE ${future}`, [id]);
      await db.query('DELETE FROM task_series_skips WHERE series_id = $1', [id]);
    } else {
      await db.query(
        `UPDATE tasks SET title=$2, description=$3, priority=$4, category_id=$5, updated_by=$6, color=$7, updated_at=now() WHERE ${future}`,
        [id, d.title, d.description, d.priority, d.category_id ?? null, req.user.id, d.color ?? null]);
      await db.query(`DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE ${future})`, [id]);
      await db.query(
        `INSERT INTO task_assignees (task_id, user_id)
         SELECT t.id, u FROM tasks t, unnest($2::int[]) u WHERE ${future.replace(/series_id|status|start_at/g, (m) => 't.' + m)}
           AND EXISTS (SELECT 1 FROM users WHERE id = u) ON CONFLICT DO NOTHING`, [id, assignees]);
      // Чек-лист заменяется там, где ни один пункт ещё не отмечен
      const untouched = `SELECT id FROM tasks t WHERE ${future.replace(/series_id|status|start_at/g, (m) => 't.' + m)}
        AND NOT EXISTS (SELECT 1 FROM task_checklist cl WHERE cl.task_id = t.id AND cl.done)`;
      await db.query(`DELETE FROM task_checklist WHERE task_id IN (${untouched})`, [id]);
      await db.query(
        `INSERT INTO task_checklist (task_id, text, done, position)
         SELECT t.id, c.value->>'text', FALSE, (c.n - 1)::int FROM (${untouched}) t
          CROSS JOIN LATERAL jsonb_array_elements($2::jsonb) WITH ORDINALITY AS c(value, n)`, [id, JSON.stringify(d.checklist)]);
    }
    await logActivity(db, req.user.id, 'update', 'series', id, { title: d.title });
  });
  await ensureOccurrences(null, null, id);
  res.json({ series: await getSeries(id, req.user) });
}));

// Удалить серию. Выполненные повторы остаются как обычные задачи (история работы).
r.delete('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const s = await getSeries(id, req.user);
  await withTransaction(async (db) => {
    await db.query(`DELETE FROM tasks WHERE series_id = $1 AND status <> 'done'`, [id]);
    await db.query('DELETE FROM task_series WHERE id = $1', [id]);
    await logActivity(db, req.user.id, 'delete', 'series', id, { title: s.title });
  });
  res.json({ ok: true });
}));

export default r;
