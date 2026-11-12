import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { ah, validate, HttpError } from '../validate.js';
import { ensureOccurrences, EVERY, validTz, isSeriesFreq, seriesTiming, FREQ_SQL } from '../series.js';
import { taskCond } from '../scope.js';
import { taskAssigned, taskCommented } from '../notify.js';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const ticketIdOf = (t) => t.helpdesk_ticket_id;

const r = Router();

const STATUS = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const PRIORITY = z.enum(['low', 'normal', 'high', 'critical']);

const taskBody = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(200),
  description: z.string().max(10000).default(''),
  start_at: z.coerce.date(),
  end_at: z.coerce.date(),
  all_day: z.boolean().default(false),
  status: STATUS.default('todo'),
  priority: PRIORITY.default('normal'),
  category_id: z.number().int().nullable().optional(),
  // Свой цвет задачи; null — по настройке раскраски (категория, исполнитель…)
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в виде #RRGGBB').nullable().optional(),
  assignees: z.array(z.number().int()).default([]),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false) })).optional(),
  // daily/weekdays/weekly — несколько отдельных копий (count);
  // monthly/quarterly/halfyear/yearly — периодическая задача без конца (или до until)
  repeat: z.object({
    freq: z.enum(['daily', 'weekdays', 'workdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'halfyear', 'yearly']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    count: z.number().int().min(2).max(52).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    tz: z.string().max(64).optional(),
  }).nullable().optional(),
}).refine((d) => d.end_at >= d.start_at, { message: 'Окончание не может быть раньше начала', path: ['end_at'] });

// Базовый SELECT: задача + категория + исполнители + прогресс чек-листа
const TASK_SELECT = `
  SELECT t.*,
    c.name AS category_name, c.color AS category_color,
    CASE WHEN cu.is_system THEN 'Служба ИТ' ELSE cu.name END AS created_by_name, CASE WHEN uu.is_system THEN 'Служба ИТ' ELSE uu.name END AS updated_by_name,
    COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.color) ORDER BY u.name)
      FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id AND NOT u.is_system), '[]') AS assignees,
    (SELECT count(*)::int FROM task_checklist cl WHERE cl.task_id = t.id) AS checklist_total,
    (SELECT count(*)::int FROM task_checklist cl WHERE cl.task_id = t.id AND cl.done) AS checklist_done,
    (SELECT count(*)::int FROM task_comments cm WHERE cm.task_id = t.id) AS comment_count,
    ts.every_months AS series_every_months, to_char(ts.until, 'YYYY-MM-DD') AS series_until,
    CASE WHEN ts.id IS NULL THEN NULL ELSE ${FREQ_SQL('ts')} END AS series_freq, ts.weekdays AS series_weekdays
  FROM tasks t
  LEFT JOIN task_series ts ON ts.id = t.series_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users uu ON uu.id = t.updated_by`;

function buildFilters(q, user) {
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (q.from) add('t.end_at >= ?', new Date(q.from));
  if (q.to) add('t.start_at < ?', new Date(q.to));
  if (q.status) add('t.status::text = ANY(?::text[])', String(q.status).split(','));
  if (q.priority) add('t.priority::text = ANY(?::text[])', String(q.priority).split(','));
  // Списки через запятую; «none» — «без категории» / «без исполнителя»
  const anyOf = (v, idSql, noneSql) => {
    const parts = String(v).split(',');
    const ids = parts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const or = [];
    if (ids.length) { vals.push(ids); or.push(idSql.replace('?', `$${vals.length}`)); }
    if (parts.includes('none')) or.push(noneSql);
    where.push(or.length ? `(${or.join(' OR ')})` : 'FALSE');
  };
  if (q.category) anyOf(q.category, 't.category_id = ANY(?::int[])', 't.category_id IS NULL');
  if (q.assignee) {
    anyOf(q.assignee, 'EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ANY(?::int[]))',
      'NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id)');
  }
  if (q.author) anyOf(q.author, 't.created_by = ANY(?::int[])', 'FALSE');
  // Вид задачи: обычная, периодическая, из заявки
  if (q.source) {
    const src = String(q.source).split(',');
    const or = [];
    if (src.includes('series')) or.push('t.series_id IS NOT NULL');
    if (src.includes('helpdesk')) or.push('t.helpdesk_ticket_id IS NOT NULL');
    if (src.includes('plain')) or.push('(t.series_id IS NULL AND t.helpdesk_ticket_id IS NULL)');
    where.push(or.length ? `(${or.join(' OR ')})` : 'FALSE');
  }
  if (q.mine === '1') add('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)', user.id);
  if (q.overdue === '1') { add("t.end_at < ?", new Date()); where.push("t.status IN ('todo','in_progress')"); }
  const scoped = taskCond(user, vals);
  if (scoped) where.push(scoped);
  if (q.q) {
    vals.push(`%${q.q}%`);
    where.push(`(t.title ILIKE $${vals.length} OR t.description ILIKE $${vals.length})`);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

// Ограничения видимости («только свои», выбранные категории/сотрудники): недоступная задача как будто не существует
r.param('id', (req, res, next, id) => {
  const vals = [Number(id) || 0];
  const cond = taskCond(req.user, vals);
  if (!cond) return next();
  query(`SELECT 1 FROM tasks t WHERE t.id = $1 AND ${cond}`, vals)
    .then(({ rows }) => (rows[0] ? next() : res.status(404).json({ error: 'Задача не найдена' })))
    .catch(next);
});

// Для запрошенного периода — создать недостающие повторы периодических задач
async function prepare(q) {
  if (q.from || q.to) {
    const d = (v) => (v && !isNaN(new Date(v)) ? new Date(v) : null);
    await ensureOccurrences(d(q.from), d(q.to));
  }
}

r.get('/', ah(async (req, res) => {
  await prepare(req.query);
  const { where, vals } = buildFilters(req.query, req.user);
  const limit = Math.min(Number(req.query.limit) || 1000, 5000); // 5000 — для вида «Год»
  const { rows } = await query(`${TASK_SELECT} ${where} ORDER BY t.start_at LIMIT ${limit}`, vals);
  res.json({ tasks: rows });
}));

// Экспорт в iCalendar (.ics) — можно импортировать в Outlook / Google Calendar
r.get('/export.ics', ah(async (req, res) => {
  await prepare(req.query);
  const { where, vals } = buildFilters(req.query, req.user);
  const { rows } = await query(`${TASK_SELECT} ${where} ORDER BY t.start_at LIMIT 5000`, vals);
  const esc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dept Calendar//RU', 'CALSCALE:GREGORIAN'];
  for (const t of rows) {
    lines.push('BEGIN:VEVENT', `UID:task-${t.id}@dept-calendar`, `DTSTAMP:${dt(t.updated_at)}`);
    if (t.all_day) {
      const end = new Date(t.end_at); end.setUTCDate(end.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${day(t.start_at)}`, `DTEND;VALUE=DATE:${day(end)}`);
    } else {
      lines.push(`DTSTART:${dt(t.start_at)}`, `DTEND:${dt(t.end_at)}`);
    }
    lines.push(`SUMMARY:${esc(t.title)}`);
    if (t.description) lines.push(`DESCRIPTION:${esc(t.description)}`);
    if (t.category_name) lines.push(`CATEGORIES:${esc(t.category_name)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tasks.ics"');
  res.send(lines.join('\r\n'));
}));

// Выгрузка задач в Excel — период и отборы те же, что на экране
r.get('/export.xlsx', ah(async (req, res) => {
  await prepare(req.query);
  const { where, vals } = buildFilters(req.query, req.user);
  const { rows } = await query(`${TASK_SELECT} ${where} ORDER BY t.start_at LIMIT 20000`, vals);
  const ExcelJS = requireCjs('exceljs');
  const ST = { todo: 'К выполнению', in_progress: 'В работе', done: 'Выполнена', cancelled: 'Отменена' };
  const PR = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', critical: 'Критический' };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Задачи', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Задача', key: 'title', width: 44 }, { header: 'Начало', key: 'start', width: 17 }, { header: 'Окончание', key: 'end', width: 17 },
    { header: 'Статус', key: 'status', width: 14 }, { header: 'Приоритет', key: 'priority', width: 12 }, { header: 'Категория', key: 'category', width: 20 },
    { header: 'Исполнители', key: 'assignees', width: 30 }, { header: 'Автор', key: 'author', width: 22 },
    { header: 'Выполнена', key: 'completed', width: 17 }, { header: 'Описание', key: 'description', width: 50 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  for (const t of rows) {
    const row = ws.addRow({
      title: t.title, start: new Date(t.start_at), end: new Date(t.end_at), status: ST[t.status] || t.status, priority: PR[t.priority] || t.priority,
      category: t.category_name || '', assignees: (t.assignees || []).map((a) => a.name).join(', '), author: t.created_by_name || '',
      completed: t.completed_at ? new Date(t.completed_at) : '', description: String(t.description || '').slice(0, 2000),
    });
    const fmt = t.all_day ? 'dd.mm.yyyy' : 'dd.mm.yyyy hh:mm';
    row.getCell('start').numFmt = fmt; row.getCell('end').numFmt = fmt;
  }
  ws.getColumn('completed').numFmt = 'dd.mm.yyyy hh:mm';
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="tasks.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

r.get('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Задача не найдена');
  const [checklist, comments, history] = await Promise.all([
    query('SELECT id, text, done FROM task_checklist WHERE task_id=$1 ORDER BY position, id', [id]),
    query(`SELECT cm.id, cm.body, cm.created_at, cm.user_id, CASE WHEN u.is_system THEN 'Служба ИТ' ELSE u.name END AS user_name, CASE WHEN u.is_system THEN '#5E6C84' ELSE u.color END AS user_color
           FROM task_comments cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.task_id=$1 ORDER BY cm.created_at`, [id]),
    query(`SELECT a.action, a.details, a.created_at, CASE WHEN u.is_system THEN 'Служба ИТ' ELSE u.name END AS user_name
           FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
           WHERE a.entity='task' AND a.entity_id=$1 ORDER BY a.created_at DESC LIMIT 50`, [id]),
  ]);
  res.json({ task: { ...rows[0], checklist: checklist.rows, comments: comments.rows, history: history.rows } });
}));

async function fetchTask(db, id) {
  const { rows } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  return rows[0];
}

async function setAssignees(db, taskId, ids) {
  await db.query('DELETE FROM task_assignees WHERE task_id=$1', [taskId]);
  if (ids.length) {
    await db.query(
      'INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING',
      [taskId, [...new Set(ids)]]
    );
  }
}

async function setChecklist(db, taskId, items) {
  await db.query('DELETE FROM task_checklist WHERE task_id=$1', [taskId]);
  for (const [i, it] of items.entries()) {
    await db.query('INSERT INTO task_checklist (task_id, text, done, position) VALUES ($1,$2,$3,$4)', [taskId, it.text, it.done, i]);
  }
}

function shiftDate(date, freq, n) {
  const d = new Date(date);
  if (freq === 'daily') d.setDate(d.getDate() + n);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + n);
  return d;
}

// Сдвиги для повторяющихся задач (для "по будням" пропускаем субботу и воскресенье)
function occurrenceOffsets(start, repeat) {
  if (!repeat) return [0];
  if (repeat.freq !== 'weekdays') return Array.from({ length: repeat.count }, (_, i) => i);
  const out = [];
  for (let i = 0; out.length < repeat.count && i < repeat.count * 3; i++) {
    const wd = shiftDate(start, 'daily', i).getDay();
    if (wd !== 0 && wd !== 6) out.push(i);
  }
  return out;
}

r.post('/', requireRole('editor'), ah(async (req, res) => {
  const d = validate(taskBody, req.body);
  // Регулярная задача (без ограничения числа повторов): помесячные — всегда; по дням — если не задано количество копий
  if (d.repeat && (EVERY[d.repeat.freq] || (isSeriesFreq(d.repeat.freq) && !d.repeat.count))) {
    return res.status(201).json(await createSeries(d, req.user));
  }
  if (d.repeat && !d.repeat.count) throw new HttpError(400, 'Укажите количество повторений');
  const created = await withTransaction(async (db) => {
    const ids = [];
    const freq = d.repeat?.freq === 'weekdays' ? 'daily' : d.repeat?.freq;
    for (const n of occurrenceOffsets(d.start_at, d.repeat)) {
      const { rows } = await db.query(
        `INSERT INTO tasks (title, description, start_at, end_at, all_day, status, priority, category_id, created_by, updated_by, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) RETURNING id`,
        [d.title, d.description, shiftDate(d.start_at, freq, n), shiftDate(d.end_at, freq, n),
         d.all_day, d.status, d.priority, d.category_id ?? null, req.user.id, d.color ?? null]
      );
      const id = rows[0].id;
      await setAssignees(db, id, d.assignees);
      if (d.checklist) await setChecklist(db, id, d.checklist);
      await logActivity(db, req.user.id, 'create', 'task', id, { title: d.title });
      ids.push(id);
    }
    return Promise.all(ids.map((id) => fetchTask(db, id)));
  });
  taskAssigned(created[0].id, d.assignees, req.user.id, created.length - 1);
  res.status(201).json({ task: created[0], tasks: created });
}));

// Периодическая задача: серия + повторы на год вперёд. Ответ — первый созданный повтор.
async function createSeries(d, user) {
  const timing = seriesTiming(d.repeat.freq, d.repeat.weekdays);
  const seriesId = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO task_series (title, description, start_at, end_at, all_day, priority, category_id, every_months, until,
                                assignees, checklist, created_by, updated_by, tz, color, every_days, weekdays)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16) RETURNING id`,
      [d.title, d.description, d.start_at, d.end_at, d.all_day, d.priority, d.category_id ?? null, timing.every_months,
        d.repeat.until || null, [...new Set(d.assignees)], JSON.stringify((d.checklist || []).map((c) => ({ text: c.text }))), user.id,
        await validTz(db, d.repeat.tz), d.color ?? null, timing.every_days, timing.weekdays]);
    await logActivity(db, user.id, 'create', 'series', rows[0].id, { title: d.title, freq: d.repeat.freq, every_months: timing.every_days ? undefined : timing.every_months });
    return rows[0].id;
  });
  await ensureOccurrences(null, null, seriesId);
  const { rows } = await query(`${TASK_SELECT} WHERE t.series_id = $1 ORDER BY t.series_idx LIMIT 1`, [seriesId]);
  if (rows[0]) taskAssigned(rows[0].id, d.assignees, user.id);
  return { task: rows[0] || null, tasks: rows, series_id: seriesId };
}

const LABELS = { title: 'название', description: 'описание', start_at: 'начало', end_at: 'окончание', all_day: 'весь день',
  status: 'статус', priority: 'приоритет', category_id: 'категория', color: 'цвет' };

r.patch('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = validate(taskBody.innerType().omit({ repeat: true }).partial(), req.body);
  let added = [];
  let statusChanged = false;
  const task = await withTransaction(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id]);
    if (!old) throw new HttpError(404, 'Задача не найдена');
    statusChanged = !!(d.status && d.status !== old.status && old.helpdesk_ticket_id);
    if (d.assignees) {
      const was = new Set((await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id));
      added = [...new Set(d.assignees)].filter((u) => !was.has(u));
    }
    const start = d.start_at ?? old.start_at;
    const end = d.end_at ?? old.end_at;
    if (new Date(end) < new Date(start)) throw new HttpError(400, 'Окончание не может быть раньше начала');

    const sets = []; const vals = [id]; const changed = [];
    for (const k of Object.keys(LABELS)) {
      if (!(k in d)) continue;
      const a = old[k] instanceof Date ? old[k].getTime() : old[k];
      const b = d[k] instanceof Date ? d[k].getTime() : d[k] ?? null;
      if (a === b) continue;
      vals.push(d[k] ?? null); sets.push(`${k} = $${vals.length}`); changed.push(LABELS[k]);
    }
    vals.push(req.user.id);
    sets.push(`updated_by = $${vals.length}`, 'updated_at = now()');
    await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (d.assignees) { await setAssignees(db, id, d.assignees); changed.push('исполнители'); }
    if (d.checklist) { await setChecklist(db, id, d.checklist); changed.push('чек-лист'); }
    if (changed.length) {
      await logActivity(db, req.user.id, 'update', 'task', id, {
        title: d.title ?? old.title, fields: changed, ...(d.status && d.status !== old.status ? { status: d.status } : {}),
      });
    }
    return fetchTask(db, id);
  });
  taskAssigned(id, added, req.user.id);
  // Задача из заявки helpdesk: статус задачи меняет и заявку
  let ticket = null;
  if (statusChanged && req.portalUser) {
    try {
      const sync = requireCjs('../../helpdesk/calendar-sync.js');
      ticket = await sync.fromTask(id, d.status, req.portalUser);
      if (ticket) await sync.syncTicket(ticketIdOf(task), req.user.id);
    } catch (e) { console.error('Задача → заявка:', e.message); }
  }
  res.json({ task: ticket ? (await query(`${TASK_SELECT} WHERE t.id = $1`, [id])).rows[0] || task : task, ticket });
}));

r.post('/:id/duplicate', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const task = await withTransaction(async (db) => {
    const { rows: [n] } = await db.query(
      `INSERT INTO tasks (title, description, start_at, end_at, all_day, status, priority, category_id, created_by, updated_by, color)
       SELECT title || ' (копия)', description, start_at, end_at, all_day, 'todo', priority, category_id, $2, $2, color
       FROM tasks WHERE id=$1 RETURNING id`, [id, req.user.id]);
    if (!n) throw new HttpError(404, 'Задача не найдена');
    await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $2, user_id FROM task_assignees WHERE task_id=$1', [id, n.id]);
    await db.query('INSERT INTO task_checklist (task_id, text, done, position) SELECT $2, text, false, position FROM task_checklist WHERE task_id=$1', [id, n.id]);
    await logActivity(db, req.user.id, 'create', 'task', n.id, { duplicated_from: id });
    return fetchTask(db, n.id);
  });
  res.status(201).json({ task });
}));

// Удаление. Для повтора периодической задачи scope: one — только этот повтор (больше не появится),
// following — этот и все следующие (серия заканчивается; выполненные остаются), all — вся серия.
r.delete('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const scope = ['one', 'following', 'all'].includes(req.query.scope) ? req.query.scope : 'one';
  const removed = await withTransaction(async (db) => {
    const { rows: [t] } = await db.query('SELECT id, title, series_id, series_idx, start_at FROM tasks WHERE id=$1 FOR UPDATE', [id]);
    if (!t) throw new HttpError(404, 'Задача не найдена');
    if (!t.series_id || scope === 'one') {
      await db.query('DELETE FROM tasks WHERE id=$1', [id]);
      if (t.series_id) {
        await db.query('INSERT INTO task_series_skips (series_id, idx) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t.series_id, t.series_idx]);
      }
      await logActivity(db, req.user.id, 'delete', 'task', id, { title: t.title });
      return 1;
    }
    if (scope === 'following') {
      // Серия заканчивается накануне этого повтора
      await db.query(`UPDATE task_series SET until = (($2::timestamptz AT TIME ZONE tz)::date - 1), updated_at = now(), updated_by = $3
                       WHERE id = $1`, [t.series_id, t.start_at, req.user.id]);
      const { rowCount } = await db.query(
        `DELETE FROM tasks WHERE series_id=$1 AND (id=$3 OR (series_idx > $2 AND status <> 'done'))`, [t.series_id, t.series_idx, id]);
      await logActivity(db, req.user.id, 'update', 'series', t.series_id, { title: t.title, fields: ['окончание повторов'] });
      return rowCount;
    }
    const { rowCount } = await db.query(`DELETE FROM tasks WHERE series_id=$1 AND (id=$2 OR status <> 'done')`, [t.series_id, id]);
    await db.query('DELETE FROM task_series WHERE id=$1', [t.series_id]);
    await logActivity(db, req.user.id, 'delete', 'series', t.series_id, { title: t.title });
    return rowCount;
  });
  res.json({ ok: true, removed });
}));

// ---- Чек-лист: отметка пункта без открытия формы редактирования
r.patch('/:id/checklist/:itemId', requireRole('editor'), ah(async (req, res) => {
  const { done } = validate(z.object({ done: z.boolean() }), req.body);
  const { rows } = await query(
    'UPDATE task_checklist SET done=$3 WHERE id=$2 AND task_id=$1 RETURNING id, text, done',
    [req.params.id, req.params.itemId, done]
  );
  if (!rows[0]) throw new HttpError(404, 'Пункт не найден');
  res.json({ item: rows[0] });
}));

// ---- Комментарии: редактор и выше. Просмотр доступен всем.
r.post('/:id/comments', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { body } = validate(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
  const exists = await query('SELECT 1 FROM tasks WHERE id=$1', [id]);
  if (!exists.rowCount) throw new HttpError(404, 'Задача не найдена');
  const { rows } = await query(
    `INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)
     RETURNING id, body, created_at, user_id, $4::text AS user_name, $5::text AS user_color`,
    [id, req.user.id, body, req.user.name, req.user.color]
  );
  await logActivity({ query }, req.user.id, 'comment', 'task', id, {});
  taskCommented(id, req.user, body);
  res.status(201).json({ comment: rows[0] });
}));

r.delete('/:id/comments/:cid', requireRole('editor'), ah(async (req, res) => {
  const { rows } = await query('SELECT user_id FROM task_comments WHERE id=$1 AND task_id=$2', [req.params.cid, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Комментарий не найден');
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Можно удалять только свои комментарии');
  await query('DELETE FROM task_comments WHERE id=$1', [req.params.cid]);
  res.json({ ok: true });
}));

export default r;
