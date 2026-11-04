import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { ah, validate, HttpError } from '../validate.js';

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
  assignees: z.array(z.number().int()).default([]),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false) })).optional(),
  repeat: z.object({
    freq: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
    count: z.number().int().min(2).max(52),
  }).nullable().optional(),
}).refine((d) => d.end_at >= d.start_at, { message: 'Окончание не может быть раньше начала', path: ['end_at'] });

// Базовый SELECT: задача + категория + исполнители + прогресс чек-листа
const TASK_SELECT = `
  SELECT t.*,
    c.name AS category_name, c.color AS category_color,
    cu.name AS created_by_name, uu.name AS updated_by_name,
    COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.color) ORDER BY u.name)
      FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id), '[]') AS assignees,
    (SELECT count(*)::int FROM task_checklist cl WHERE cl.task_id = t.id) AS checklist_total,
    (SELECT count(*)::int FROM task_checklist cl WHERE cl.task_id = t.id AND cl.done) AS checklist_done,
    (SELECT count(*)::int FROM task_comments cm WHERE cm.task_id = t.id) AS comment_count
  FROM tasks t
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
  if (q.category) add('t.category_id = ANY(?::int[])', String(q.category).split(',').map(Number));
  if (q.assignee) add('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ANY(?::int[]))', String(q.assignee).split(',').map(Number));
  if (q.mine === '1') add('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)', user.id);
  if (q.overdue === '1') { add("t.end_at < ?", new Date()); where.push("t.status IN ('todo','in_progress')"); }
  if (user.own_only) {
    vals.push(user.id);
    const n = vals.length;
    where.push(`(t.created_by = $${n} OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $${n}))`);
  }
  if (q.q) {
    vals.push(`%${q.q}%`);
    where.push(`(t.title ILIKE $${vals.length} OR t.description ILIKE $${vals.length})`);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

// Ограничение «только свои задачи»: чужая задача для такого пользователя как будто не существует
r.param('id', (req, res, next, id) => {
  if (!req.user.own_only) return next();
  query(`SELECT 1 FROM tasks t WHERE t.id = $1 AND (t.created_by = $2 OR EXISTS
           (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $2))`, [Number(id) || 0, req.user.id])
    .then(({ rows }) => (rows[0] ? next() : res.status(404).json({ error: 'Задача не найдена' })))
    .catch(next);
});

r.get('/', ah(async (req, res) => {
  const { where, vals } = buildFilters(req.query, req.user);
  const limit = Math.min(Number(req.query.limit) || 1000, 2000);
  const { rows } = await query(`${TASK_SELECT} ${where} ORDER BY t.start_at LIMIT ${limit}`, vals);
  res.json({ tasks: rows });
}));

// Экспорт в iCalendar (.ics) — можно импортировать в Outlook / Google Calendar
r.get('/export.ics', ah(async (req, res) => {
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

r.get('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Задача не найдена');
  const [checklist, comments, history] = await Promise.all([
    query('SELECT id, text, done FROM task_checklist WHERE task_id=$1 ORDER BY position, id', [id]),
    query(`SELECT cm.id, cm.body, cm.created_at, cm.user_id, u.name AS user_name, u.color AS user_color
           FROM task_comments cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.task_id=$1 ORDER BY cm.created_at`, [id]),
    query(`SELECT a.action, a.details, a.created_at, u.name AS user_name
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
  const created = await withTransaction(async (db) => {
    const ids = [];
    const freq = d.repeat?.freq === 'weekdays' ? 'daily' : d.repeat?.freq;
    for (const n of occurrenceOffsets(d.start_at, d.repeat)) {
      const { rows } = await db.query(
        `INSERT INTO tasks (title, description, start_at, end_at, all_day, status, priority, category_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [d.title, d.description, shiftDate(d.start_at, freq, n), shiftDate(d.end_at, freq, n),
         d.all_day, d.status, d.priority, d.category_id ?? null, req.user.id]
      );
      const id = rows[0].id;
      await setAssignees(db, id, d.assignees);
      if (d.checklist) await setChecklist(db, id, d.checklist);
      await logActivity(db, req.user.id, 'create', 'task', id, { title: d.title });
      ids.push(id);
    }
    return Promise.all(ids.map((id) => fetchTask(db, id)));
  });
  res.status(201).json({ task: created[0], tasks: created });
}));

const LABELS = { title: 'название', description: 'описание', start_at: 'начало', end_at: 'окончание', all_day: 'весь день',
  status: 'статус', priority: 'приоритет', category_id: 'категория' };

r.patch('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = validate(taskBody.innerType().omit({ repeat: true }).partial(), req.body);
  const task = await withTransaction(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id]);
    if (!old) throw new HttpError(404, 'Задача не найдена');
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
  res.json({ task });
}));

r.post('/:id/duplicate', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const task = await withTransaction(async (db) => {
    const { rows: [n] } = await db.query(
      `INSERT INTO tasks (title, description, start_at, end_at, all_day, status, priority, category_id, created_by, updated_by)
       SELECT title || ' (копия)', description, start_at, end_at, all_day, 'todo', priority, category_id, $2, $2
       FROM tasks WHERE id=$1 RETURNING id`, [id, req.user.id]);
    if (!n) throw new HttpError(404, 'Задача не найдена');
    await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $2, user_id FROM task_assignees WHERE task_id=$1', [id, n.id]);
    await db.query('INSERT INTO task_checklist (task_id, text, done, position) SELECT $2, text, false, position FROM task_checklist WHERE task_id=$1', [id, n.id]);
    await logActivity(db, req.user.id, 'create', 'task', n.id, { duplicated_from: id });
    return fetchTask(db, n.id);
  });
  res.status(201).json({ task });
}));

r.delete('/:id', requireRole('editor'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('DELETE FROM tasks WHERE id=$1 RETURNING title', [id]);
  if (!rows[0]) throw new HttpError(404, 'Задача не найдена');
  await logActivity({ query }, req.user.id, 'delete', 'task', id, { title: rows[0].title });
  res.json({ ok: true });
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
