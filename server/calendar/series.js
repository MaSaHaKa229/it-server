// Периодические задачи: создание задач-повторов по сериям.
// Повторы создаются «по требованию» — для периода, который открыли в календаре, — и заранее
// на год вперёд (при запуске и раз в несколько часов), чтобы они попадали в сводки и статистику.
// Повтор номер k = даты первой задачи + k × период (месяцев). 31-е число в коротком месяце
// становится последним днём месяца, 29 февраля в невисокосный год — 28-м.
// Повторы, закончившиеся раньше дня создания серии, не создаются: задача «1–30 мая»,
// заведённая в ноябре, впервые появится в мае следующего года.
import { query } from './db.js';

const YEARS_AHEAD = 10; // дальше этого горизонта повторы не создаются

const SQL = `
WITH s AS (
  SELECT * FROM task_series WHERE ($3::int IS NULL OR id = $3::int)
), occ AS (
  SELECT s.id AS series_id, k AS idx,
         ((s.start_at AT TIME ZONE s.tz) + make_interval(months => k * s.every_months)) AT TIME ZONE s.tz AS st,
         ((s.end_at AT TIME ZONE s.tz) + make_interval(months => k * s.every_months)) AT TIME ZONE s.tz AS en
    FROM s, generate_series(0, GREATEST(0,
           ((extract(year FROM $2::timestamptz) - extract(year FROM s.start_at)) * 12
            + extract(month FROM $2::timestamptz) - extract(month FROM s.start_at))::int / s.every_months + 1)) k
), todo AS (
  SELECT o.series_id, o.idx, o.st, GREATEST(o.en, o.st) AS en
    FROM occ o JOIN s ON s.id = o.series_id
   WHERE o.st < $2::timestamptz
     AND GREATEST(o.en, o.st) + CASE WHEN s.all_day THEN interval '1 day' ELSE interval '0' END > $1::timestamptz
     AND GREATEST(o.en, o.st) + CASE WHEN s.all_day THEN interval '1 day' ELSE interval '0' END > (date_trunc('day', s.created_at AT TIME ZONE s.tz) AT TIME ZONE s.tz)
     AND (s.until IS NULL OR o.st < ((s.until + 1)::timestamp AT TIME ZONE s.tz))
     AND NOT EXISTS (SELECT 1 FROM task_series_skips k WHERE k.series_id = o.series_id AND k.idx = o.idx)
     AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.series_id = o.series_id AND t.series_idx = o.idx)
), ins AS (
  INSERT INTO tasks (title, description, start_at, end_at, all_day, priority, category_id, color,
                     created_by, updated_by, series_id, series_idx)
  SELECT s.title, s.description, o.st, o.en, s.all_day, s.priority, s.category_id, s.color,
         s.created_by, s.created_by, o.series_id, o.idx
    FROM todo o JOIN s ON s.id = o.series_id
  ON CONFLICT DO NOTHING
  RETURNING id, series_id
), a AS (
  INSERT INTO task_assignees (task_id, user_id)
  SELECT ins.id, u.uid FROM ins JOIN task_series s ON s.id = ins.series_id
   CROSS JOIN LATERAL unnest(s.assignees) AS u(uid)
   WHERE EXISTS (SELECT 1 FROM users WHERE id = u.uid)
  ON CONFLICT DO NOTHING
), cl AS (
  INSERT INTO task_checklist (task_id, text, done, position)
  SELECT ins.id, c.value->>'text', FALSE, (c.n - 1)::int
    FROM ins JOIN task_series s ON s.id = ins.series_id
   CROSS JOIN LATERAL jsonb_array_elements(s.checklist) WITH ORDINALITY AS c(value, n)
)
SELECT count(*)::int AS n FROM ins`;

/**
 * Создать недостающие повторы серий, попадающие в период [from, to).
 * from/to — Date или null (null: с самого начала / на год вперёд). seriesId — только одна серия.
 */
export async function ensureOccurrences(from, to, seriesId = null, db = { query }) {
  const horizon = new Date();
  horizon.setFullYear(horizon.getFullYear() + YEARS_AHEAD);
  let end = to ? new Date(to) : new Date(Date.now() + 366 * 86400000);
  if (end > horizon) end = horizon;
  const start = from ? new Date(from) : '-infinity';
  if (from && new Date(from) >= end) return 0;
  const { rows } = await db.query(SQL, [start, end, seriesId]);
  return rows[0].n;
}

/** Повторы на год вперёд — при запуске и по таймеру */
export function startSeriesTimer() {
  const run = () => ensureOccurrences(null, null).catch((e) => console.error('Периодические задачи:', e.message));
  run();
  const t = setInterval(run, 6 * 3600 * 1000);
  t.unref?.();
}

/** Часовой пояс из браузера, если PostgreSQL его знает; иначе — пояс базы */
export async function validTz(db, tz) {
  if (tz) {
    const { rows } = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [String(tz).slice(0, 64)]);
    if (rows[0]) return String(tz);
  }
  const { rows } = await db.query("SELECT current_setting('TimeZone') AS tz");
  return rows[0].tz;
}

export const EVERY = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
