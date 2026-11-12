// Периодические задачи: создание задач-повторов по сериям.
// Повторы создаются «по требованию» — для периода, который открыли в календаре, — и заранее
// (при запуске и раз в несколько часов), чтобы они попадали в сводки и статистику.
//
// Два вида серий:
//  • помесячные (every_months: месяц, квартал, полгода, год): повтор k = даты первой задачи + k × период;
//    31-е число в коротком месяце становится последним днём месяца, 29 февраля в невисокосный год — 28-м;
//  • по дням (every_days: 1 — каждый день, 7 — каждую неделю, 14 — через неделю; weekdays — дни недели 1..7):
//    номер повтора k = сдвиг в днях от первой задачи. Создаются на 2 месяца вперёд (и по требованию).
// Повторы, закончившиеся раньше дня создания серии, не создаются.
import { createRequire } from 'node:module';
import { query } from './db.js';

const YEARS_AHEAD = 10; // дальше этого горизонта повторы не создаются
const DAYS_AHEAD = 62;  // дневные повторы заранее — на два месяца

// Помесячные повторы
const MONTHS_OCC = `
s AS (
  SELECT * FROM task_series WHERE every_days IS NULL AND ($3::int IS NULL OR id = $3::int)
), occ AS (
  SELECT s.id AS series_id, k AS idx,
         ((s.start_at AT TIME ZONE s.tz) + make_interval(months => k * s.every_months)) AT TIME ZONE s.tz AS st,
         ((s.end_at AT TIME ZONE s.tz) + make_interval(months => k * s.every_months)) AT TIME ZONE s.tz AS en
    FROM s, generate_series(0, GREATEST(0,
           ((extract(year FROM $2::timestamptz) - extract(year FROM s.start_at)) * 12
            + extract(month FROM $2::timestamptz) - extract(month FROM s.start_at))::int / s.every_months + 1)) k
)`;

// Повторы по дням: каждый k-й день от первой задачи, с отбором по дням недели и чётности недели (через неделю)
const DAYS_OCC = `
s AS (
  SELECT *, (start_at AT TIME ZONE tz) AS local_start FROM task_series
   WHERE every_days IS NOT NULL AND ($3::int IS NULL OR id = $3::int)
), raw AS (
  SELECT s.id AS series_id, k AS idx, s.local_start + make_interval(days => k) AS local_day, s.*
    FROM s, generate_series(
      GREATEST(0, CASE WHEN isfinite($1::timestamptz) THEN floor(extract(epoch FROM ($1::timestamptz - s.start_at)) / 86400)::int - 2 ELSE 0 END),
      GREATEST(0, ceil(extract(epoch FROM ($2::timestamptz - s.start_at)) / 86400)::int)) k
), occ AS (
  SELECT r.series_id, r.idx,
         (r.local_day) AT TIME ZONE r.tz AS st,
         ((r.end_at AT TIME ZONE r.tz) + make_interval(days => r.idx)) AT TIME ZONE r.tz AS en
    FROM raw r
   WHERE CASE
           WHEN cardinality(r.weekdays) > 0 THEN
             extract(isodow FROM r.local_day)::int = ANY(r.weekdays)
             AND (r.every_days < 14 OR (extract(days FROM date_trunc('week', r.local_day) - date_trunc('week', r.local_start))::int / 7)
                                        % (r.every_days / 7) = 0)
           ELSE r.idx % r.every_days = 0
         END
)`;

const TAIL = `
, todo AS (
  SELECT o.series_id, o.idx, o.st, GREATEST(o.en, o.st) AS en
    FROM occ o JOIN task_series s ON s.id = o.series_id
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
    FROM todo o JOIN task_series s ON s.id = o.series_id
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

const SQL_MONTHS = `WITH ${MONTHS_OCC}${TAIL}`;
const SQL_DAYS = `WITH ${DAYS_OCC}${TAIL}`;

/**
 * Создать недостающие повторы серий, попадающие в период [from, to).
 * from/to — Date или null (null: с самого начала / заранее вперёд). seriesId — только одна серия.
 */
export async function ensureOccurrences(from, to, seriesId = null, db = { query }) {
  const horizon = new Date();
  horizon.setFullYear(horizon.getFullYear() + YEARS_AHEAD);
  const start = from ? new Date(from) : '-infinity';
  let n = 0;
  // Помесячные — на год вперёд, дневные — на два месяца (больше открывают по требованию)
  for (const [sql, ahead] of [[SQL_MONTHS, 366], [SQL_DAYS, DAYS_AHEAD]]) {
    let end = to ? new Date(to) : new Date(Date.now() + ahead * 86400000);
    if (end > horizon) end = horizon;
    if (from && new Date(from) >= end) continue;
    const { rows } = await db.query(sql, [start, end, seriesId]);
    n += rows[0].n;
  }
  return n;
}

/** Повторы заранее — при запуске и по таймеру */
export function startSeriesTimer() {
  const H = createRequire(import.meta.url)('../portal/health.js');
  H.register('series', 'Повторы регулярных задач', 6 * 60);
  const run = () => H.track('series', async () => `создано повторов: ${await ensureOccurrences(null, null)}`)
    .catch((e) => console.error('Периодические задачи:', e.message));
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

// Помесячные: месяцев в периоде
export const EVERY = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
// По дням: шаг в днях и дни недели по умолчанию (пусто — день недели первой задачи)
export const EVERY_DAYS = {
  daily: { days: 1, weekdays: [] },
  workdays: { days: 1, weekdays: [1, 2, 3, 4, 5] },
  weekly: { days: 7, weekdays: [] },
  biweekly: { days: 14, weekdays: [] },
};
export const isSeriesFreq = (f) => !!(EVERY[f] || EVERY_DAYS[f]);

/** Колонки серии по выбранной частоте: { every_months, every_days, weekdays } */
export function seriesTiming(freq, weekdays) {
  if (EVERY[freq]) return { every_months: EVERY[freq], every_days: null, weekdays: [] };
  const d = EVERY_DAYS[freq];
  const wd = freq === 'weekly' || freq === 'biweekly'
    ? [...new Set((weekdays || []).map(Number).filter((n) => n >= 1 && n <= 7))].sort()
    : d.weekdays;
  return { every_months: 1, every_days: d.days, weekdays: wd };
}

/** Ключ частоты серии (для клиента) — SQL-выражение по псевдониму таблицы */
export const FREQ_SQL = (a) => `CASE WHEN ${a}.every_days IS NULL THEN
    CASE ${a}.every_months WHEN 1 THEN 'monthly' WHEN 3 THEN 'quarterly' WHEN 6 THEN 'halfyear' ELSE 'yearly' END
  WHEN ${a}.every_days = 1 AND cardinality(${a}.weekdays) > 0 THEN 'workdays'
  WHEN ${a}.every_days = 1 THEN 'daily' WHEN ${a}.every_days = 14 THEN 'biweekly' ELSE 'weekly' END`;
