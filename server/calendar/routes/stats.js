// Статистика по задачам: служба ИТ в целом и каждый сотрудник. Только для администраторов календаря.
//
// Определения (одинаковые для службы ИТ и сотрудника):
//   срок задачи      — окончание; у задачи «на весь день» — конец последнего дня;
//   выполнено        — переведено в «Выполнено» в выбранном периоде (completed_at);
//   в срок           — выполнено не позже срока;
//   сроки в периоде  — задачи со сроком внутри периода (до текущего момента), кроме отменённых;
//                      «соблюдено» — выполнены не позже срока;
//   открыто/просрочено сейчас — текущее состояние, от периода не зависит.
// Задача с несколькими исполнителями учитывается у каждого из них, а в итогах службы ИТ — один раз.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ah, validate, HttpError } from '../validate.js';
import { ensureOccurrences } from '../series.js';

const r = Router();

const params = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  category: z.string().regex(/^\d+(,\d+)*$/).optional(),
  user: z.coerce.number().int().positive().optional(),
});

const DAY = 86400000;

// Шаг графика по длине периода
const stepFor = (from, to) => {
  const days = (to - from) / DAY;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
};

// Набор задач, по которому считается статистика ($3 — категории, $4 — исполнитель)
const SCOPE = `
  scope AS (
    SELECT t.id, t.title, t.status, t.priority, t.category_id, t.created_at, t.start_at, t.end_at, t.all_day,
           t.completed_at, t.updated_at, t.helpdesk_ticket_id,
           CASE WHEN t.all_day THEN t.end_at + interval '1 day' ELSE t.end_at END AS deadline
      FROM tasks t
     WHERE ($3::int[] IS NULL OR t.category_id = ANY($3::int[]))
       AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $4))
  )`;

// Показатели для группы задач s (параметры: $1 — начало, $2 — конец периода)
const METRICS = `
  count(s.id) FILTER (WHERE s.created_at >= $1 AND s.created_at < $2)::int AS created,
  count(s.id) FILTER (WHERE s.status <> 'cancelled' AND s.start_at < $2 AND s.deadline > $1)::int AS planned,
  count(s.id) FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2)::int AS done,
  count(s.id) FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2 AND s.completed_at <= s.deadline)::int AS done_on_time,
  count(s.id) FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2 AND s.completed_at > s.deadline)::int AS done_late,
  count(s.id) FILTER (WHERE s.status = 'cancelled' AND s.updated_at >= $1 AND s.updated_at < $2)::int AS cancelled,
  count(s.id) FILTER (WHERE s.status <> 'cancelled' AND s.deadline >= $1 AND s.deadline < LEAST($2, now()))::int AS due,
  count(s.id) FILTER (WHERE s.status <> 'cancelled' AND s.deadline >= $1 AND s.deadline < LEAST($2, now())
                        AND s.completed_at <= s.deadline)::int AS due_met,
  count(s.id) FILTER (WHERE s.status IN ('todo', 'in_progress'))::int AS open_now,
  count(s.id) FILTER (WHERE s.status = 'in_progress')::int AS in_progress_now,
  count(s.id) FILTER (WHERE s.status IN ('todo', 'in_progress') AND s.deadline < now())::int AS overdue_now,
  round((avg(extract(epoch FROM s.completed_at - s.created_at))
    FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2) / 3600)::numeric, 1)::float AS avg_lead_hours,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.completed_at - s.created_at))
    FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2) / 3600)::numeric, 1)::float AS median_lead_hours,
  round((avg(extract(epoch FROM s.completed_at - s.deadline))
    FILTER (WHERE s.completed_at >= $1 AND s.completed_at < $2 AND s.completed_at > s.deadline) / 3600)::numeric, 1)::float AS avg_late_hours,
  count(s.id) FILTER (WHERE s.helpdesk_ticket_id IS NOT NULL AND s.completed_at >= $1 AND s.completed_at < $2)::int AS done_tickets`;

const TASK_LIST = (where, order, limit = 50) => `
  WITH ${SCOPE}
  SELECT s.id, s.title, s.status, s.priority, s.start_at, s.end_at, s.all_day, s.deadline, s.completed_at,
         s.helpdesk_ticket_id, c.name AS category_name, c.color AS category_color,
         COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.color) ORDER BY u.name)
           FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = s.id AND NOT u.is_system), '[]') AS assignees
    FROM scope s LEFT JOIN categories c ON c.id = s.category_id
   WHERE $1::timestamptz < $2::timestamptz AND (${where}) -- $1/$2 упомянуты, чтобы PostgreSQL знал их тип
   ORDER BY ${order} LIMIT ${limit}`;

r.get('/', ah(async (req, res) => {
  const p = validate(params, req.query);
  if (!(p.to > p.from)) throw new HttpError(400, 'Конец периода должен быть позже начала');
  if (p.to - p.from > 3 * 366 * DAY) throw new HttpError(400, 'Период не больше трёх лет');
  const cats = p.category ? p.category.split(',').map(Number) : null;
  const vals = [p.from, p.to, cats, p.user ?? null];
  const step = stepFor(p.from, p.to);
  await ensureOccurrences(p.from, p.to);

  let person = null;
  if (p.user) {
    const { rows } = await query('SELECT id, name, color, position, is_active, has_access FROM users WHERE id = $1 AND NOT is_system', [p.user]);
    if (!rows[0]) throw new HttpError(404, 'Сотрудник не найден');
    person = rows[0];
  }

  const jobs = [
    // Итоги
    query(`WITH ${SCOPE} SELECT ${METRICS} FROM scope s`, vals),
    // Динамика: создано и выполнено по дням / неделям / месяцам
    query(`WITH ${SCOPE},
           b AS (SELECT g AS start, g + $5::interval AS stop
                   FROM generate_series(date_trunc($6, $1::timestamptz), $2::timestamptz - interval '1 second', $5::interval) g)
           SELECT b.start,
                  (SELECT count(*) FROM scope s WHERE s.created_at >= GREATEST(b.start, $1) AND s.created_at < LEAST(b.stop, $2))::int AS created,
                  (SELECT count(*) FROM scope s WHERE s.completed_at >= GREATEST(b.start, $1) AND s.completed_at < LEAST(b.stop, $2))::int AS done,
                  (SELECT count(*) FROM scope s WHERE s.completed_at >= GREATEST(b.start, $1) AND s.completed_at < LEAST(b.stop, $2)
                                                  AND s.completed_at > s.deadline)::int AS done_late
             FROM b ORDER BY b.start`, [...vals, `1 ${step}`, step]),
    // По категориям
    query(`WITH ${SCOPE}
           SELECT c.id, COALESCE(c.name, 'Без категории') AS name, COALESCE(c.color, '#97A0AF') AS color, ${METRICS}
             FROM scope s LEFT JOIN categories c ON c.id = s.category_id
            GROUP BY c.id, c.name, c.color ORDER BY done DESC, open_now DESC, name`, vals),
    // По приоритетам
    query(`WITH ${SCOPE} SELECT s.priority, ${METRICS} FROM scope s GROUP BY s.priority`, vals),
  ];

  if (person) {
    // Списки задач сотрудника
    jobs.push(
      query(TASK_LIST(`s.status IN ('todo','in_progress') AND s.deadline < now()`, 's.deadline'), vals),
      query(TASK_LIST(`s.completed_at >= $1 AND s.completed_at < $2 AND s.completed_at > s.deadline`, 's.completed_at DESC'), vals),
      query(TASK_LIST(`s.completed_at >= $1 AND s.completed_at < $2`, 's.completed_at DESC', 100), vals),
    );
  } else {
    // По сотрудникам: каждый активный сотрудник и все, у кого есть задачи
    jobs.push(
      query(`WITH ${SCOPE}
             SELECT u.id, u.name, u.color, u.position, u.is_active, u.has_access, ${METRICS}
               FROM users u
               LEFT JOIN task_assignees a ON a.user_id = u.id
               LEFT JOIN scope s ON s.id = a.task_id
              WHERE NOT u.is_system
              GROUP BY u.id
              ORDER BY u.name`, vals),
      // Задачи без исполнителя
      query(`WITH ${SCOPE} SELECT ${METRICS} FROM scope s
              WHERE NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = s.id)`, vals),
    );
  }

  const [totals, trend, byCategory, byPriority, ...rest] = await Promise.all(jobs);
  const out = {
    period: { from: p.from, to: p.to, step },
    user: person,
    totals: totals.rows[0],
    trend: trend.rows,
    byCategory: byCategory.rows.filter((c) => c.created || c.planned || c.done || c.open_now || c.cancelled),
    byPriority: byPriority.rows,
  };
  if (person) {
    out.overdue = rest[0].rows;
    out.late = rest[1].rows;
    out.done = rest[2].rows;
  } else {
    const busy = (e) => e.created || e.planned || e.done || e.open_now || e.cancelled;
    out.employees = rest[0].rows.filter((e) => (e.is_active && e.has_access) || busy(e));
    out.unassigned = rest[1].rows[0];
  }
  res.json(out);
}));

export default r;
