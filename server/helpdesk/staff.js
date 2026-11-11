// API helpdesk для сотрудников службы ИТ (внутри портала: /helpdesk/api)
//   Исполнитель    — видит все заявки, берёт свободные в работу, меняет статус своих, комментирует
//   Администратор  — плюс назначает исполнителей и сроки, настраивает виды проблем, статусы,
//                    управляет зарегистрированными сотрудниками и настройками регистрации
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');
const { level, atLeast } = require('../portal/modules');
const L = require('./lib');
const notify = require('./notify');
const calendarSync = require('./calendar-sync');

const { query, tx } = L;
const router = express.Router();
router.use(express.json({ limit: '1mb' }));

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (level(req.user, 'helpdesk') === 'none') return res.status(403).json({ error: 'Нет доступа к заявкам' });
  next();
});
const isAdmin = (req) => level(req.user, 'helpdesk') === 'admin';
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Нужны права администратора helpdesk' }));
const me = (req) => ({ userId: req.user.id });
const HEX = /^#[0-9a-fA-F]{6}$/;

// Исполнители — пользователи портала с доступом к helpdesk
async function executors() {
  const { rows } = await query(
    `SELECT id, username, COALESCE(NULLIF(full_name, ''), username) AS name, email
       FROM public.users
      WHERE is_active AND role <> 'superadmin' AND modules->>'helpdesk' IN ('executor', 'admin')
      ORDER BY 3`);
  return rows;
}

router.get('/meta', ah(async (req, res) => {
  const [statuses, categories, execs, settings] = await Promise.all([
    query('SELECT * FROM statuses ORDER BY sort, id'),
    query(`SELECT c.*, CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS default_assignee_name,
                  (SELECT count(*)::int FROM tickets t WHERE t.category_id = c.id) AS ticket_count
             FROM categories c LEFT JOIN public.users u ON u.id = c.default_assignee_id ORDER BY c.sort, c.name`),
    executors(),
    L.getSettings(),
  ]);
  res.json({
    me: { id: req.user.id, name: req.user.full_name || req.user.username, isAdmin: isAdmin(req),
      inventory: level(req.user, 'inventory') !== 'none' },
    statuses: statuses.rows, categories: categories.rows, executors: execs, priorities: L.PRIORITIES,
    settings, mailEnabled: L.mailEnabled(), helpdeskUrl: L.helpdeskUrl(),
  });
}));

// ---------- список заявок ----------
router.get('/tickets', ah(async (req, res) => {
  const q = req.query;
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\?/g, `$${vals.length}`)); };
  if (q.state === 'open') where.push('NOT s.is_closed');
  if (q.state === 'closed') where.push('s.is_closed');
  if (q.status) add('t.status_id = ANY(?::int[])', String(q.status).split(',').map(Number));
  if (q.category) add('t.category_id = ANY(?::int[])', String(q.category).split(',').map(Number));
  if (q.priority) add('t.priority = ANY(?::text[])', String(q.priority).split(','));
  if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (q.assignee === 'me') add('t.assignee_id = ?', req.user.id);
  else if (q.assignee) add('t.assignee_id = ?', Number(q.assignee));
  if (q.requester) add('t.requester_id = ?', Number(q.requester));
  if (q.overdue === '1') where.push('t.due_at < now() AND NOT s.is_closed');
  if (q.q) {
    const term = String(q.q).trim();
    if (/^#?\d+$/.test(term)) add('t.id = ?', Number(term.replace('#', '')));
    else add(`(t.title ILIKE ? OR t.description ILIKE ? OR r.full_name ILIKE ? OR r.email ILIKE ?
              OR r.department ILIKE ? OR t.location ILIKE ?)`, `%${term}%`);
  }
  const sort = {
    updated: 't.updated_at DESC',
    created: 't.created_at DESC',
    due: 't.due_at ASC NULLS LAST, t.id',
    priority: "array_position(ARRAY['critical','high','normal','low'], t.priority), t.created_at",
  }[q.sort] || 's.is_closed, t.updated_at DESC';
  const limit = Math.min(Number(q.limit) || 300, 1000);
  const { rows } = await query(
    `${L.TICKET_SELECT}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${sort} LIMIT ${limit}`, vals);
  const counts = (await query(
    `SELECT count(*) FILTER (WHERE NOT s.is_closed)::int AS open,
            count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id = $1)::int AS mine,
            count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id IS NULL)::int AS unassigned,
            count(*) FILTER (WHERE NOT s.is_closed AND t.due_at < now())::int AS overdue
       FROM tickets t JOIN statuses s ON s.id = t.status_id`, [req.user.id])).rows[0];
  res.json({ tickets: rows.map(({ description, ...t }) => t), counts });
}));

async function loadTicket(id) {
  const { rows } = await query(`${L.TICKET_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Заявка не найдена');
  return rows[0];
}

router.get('/tickets/:id', ah(async (req, res) => {
  const t = await loadTicket(intOrNull(req.params.id));
  const [comments, files, history, device, reqStats] = await Promise.all([
    query(`SELECT c.id, c.body, c.is_internal, c.created_at, c.user_id, c.requester_id,
                  COALESCE(r.full_name, CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END, '—') AS author
             FROM comments c
             LEFT JOIN requesters r ON r.id = c.requester_id
             LEFT JOIN public.users u ON u.id = c.user_id
            WHERE c.ticket_id = $1 ORDER BY c.created_at, c.id`, [t.id]),
    query(`SELECT id, comment_id, filename, mime_type, size, is_internal, created_at
             FROM attachments WHERE ticket_id = $1 ORDER BY id`, [t.id]),
    query(`SELECT h.action, h.details, h.created_at,
                  COALESCE(r.full_name, CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END) AS author
             FROM history h
             LEFT JOIN requesters r ON r.id = h.requester_id
             LEFT JOIN public.users u ON u.id = h.user_id
            WHERE h.ticket_id = $1 ORDER BY h.created_at, h.id`, [t.id]),
    t.device_id ? query(
      `SELECT d.id, dt.code || '-' || d.id AS key, dt.name AS type_name, d.hostname, d.inv_number,
              m.value AS model, e.value AS employee
         FROM public.devices d JOIN public.device_types dt ON dt.id = d.type_id
         LEFT JOIN public.lookups m ON m.id = d.model_id
         LEFT JOIN public.lookups e ON e.id = d.employee_id
        WHERE d.id = $1`, [t.device_id]) : { rows: [] },
    query(`SELECT count(*)::int AS total FROM tickets WHERE requester_id = $1`, [t.requester_id]),
  ]);
  res.json({
    ...t, comments: comments.rows, attachments: files.rows, history: history.rows,
    device: device.rows[0] || null, requester_ticket_count: reqStats.rows[0].total,
  });
}));

// ---------- изменение заявки ----------
router.patch('/tickets/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const admin = isAdmin(req);
  const events = [];
  await tx(async (db) => {
    const cur = (await db.query(
      `SELECT t.*, s.name AS status_name FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.id = $1 FOR UPDATE OF t`,
      [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Заявка не найдена');
    const mineOrFree = cur.assignee_id === req.user.id || cur.assignee_id === null;
    const sets = [];
    const vals = [id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if ('status_id' in b && Number(b.status_id) !== cur.status_id) {
      if (!admin && !mineOrFree) throw new HttpError(403, 'Менять статус может исполнитель заявки или администратор');
      const st = (await db.query('SELECT * FROM statuses WHERE id = $1', [Number(b.status_id)])).rows[0];
      if (!st) throw new HttpError(400, 'Статус не найден');
      set('status_id', st.id);
      sets.push(st.is_closed ? 'closed_at = COALESCE(closed_at, now())' : 'closed_at = NULL');
      // Исполнитель, взявший свободную заявку, становится её исполнителем
      if (!cur.assignee_id && !('assignee_id' in b) && !st.is_closed) {
        set('assignee_id', req.user.id);
        await L.addHistory(db, id, me(req), 'assignee', { from: null, to: req.user.full_name || req.user.username });
      }
      await L.addHistory(db, id, me(req), 'status', { from: cur.status_name, to: st.name });
      events.push('status');
    }
    if ('assignee_id' in b) {
      const to = b.assignee_id === null || b.assignee_id === '' ? null : Number(b.assignee_id);
      if (to !== cur.assignee_id) {
        // Исполнитель может только взять свободную заявку себе или отказаться от своей
        const selfAction = (to === req.user.id && cur.assignee_id === null) || (to === null && cur.assignee_id === req.user.id);
        if (!admin && !selfAction) throw new HttpError(403, 'Назначать исполнителей может администратор helpdesk');
        let toName = null;
        if (to !== null) {
          const ex = (await executors()).find((x) => x.id === to);
          if (!ex) throw new HttpError(400, 'Этот пользователь не может быть исполнителем');
          toName = ex.name;
        }
        const fromName = cur.assignee_id
          ? (await db.query(`SELECT COALESCE(NULLIF(full_name, ''), username) AS n FROM public.users WHERE id = $1`, [cur.assignee_id])).rows[0]?.n
          : null;
        set('assignee_id', to);
        await L.addHistory(db, id, me(req), 'assignee', { from: fromName || null, to: toName });
        if (to !== null && to !== req.user.id) events.push('assigned');
      }
    }
    if ('due_at' in b) {
      if (!admin) throw new HttpError(403, 'Сроки выставляет администратор helpdesk');
      const due = b.due_at ? new Date(b.due_at) : null;
      if (due && Number.isNaN(due.getTime())) throw new HttpError(400, 'Некорректный срок');
      const changed = (due ? due.getTime() : null) !== (cur.due_at ? cur.due_at.getTime() : null);
      if (changed) {
        set('due_at', due);
        await L.addHistory(db, id, me(req), 'due', { from: cur.due_at, to: due });
      }
    }
    if ('priority' in b && b.priority !== cur.priority) {
      if (!L.PRIORITIES[b.priority]) throw new HttpError(400, 'Неизвестный приоритет');
      if (!admin && !mineOrFree) throw new HttpError(403, 'Недостаточно прав');
      set('priority', b.priority);
      await L.addHistory(db, id, me(req), 'priority', { from: L.PRIORITIES[cur.priority], to: L.PRIORITIES[b.priority] });
    }
    if ('category_id' in b) {
      const to = b.category_id ? Number(b.category_id) : null;
      if (to !== cur.category_id) {
        if (!admin && !mineOrFree) throw new HttpError(403, 'Недостаточно прав');
        const names = (await db.query('SELECT id, name FROM categories WHERE id = ANY($1::int[])', [[cur.category_id, to].filter(Boolean)])).rows;
        const nm = (x) => names.find((n) => n.id === x)?.name || null;
        if (to && !nm(to)) throw new HttpError(400, 'Вид проблемы не найден');
        set('category_id', to);
        await L.addHistory(db, id, me(req), 'category', { from: nm(cur.category_id), to: nm(to) });
      }
    }
    if ('device_id' in b) {
      const to = b.device_id ? Number(b.device_id) : null;
      if (to !== cur.device_id) {
        if (to && !(await db.query('SELECT 1 FROM public.devices WHERE id = $1', [to])).rows[0]) throw new HttpError(400, 'Устройство не найдено');
        set('device_id', to);
        await L.addHistory(db, id, me(req), 'device', { to });
      }
    }
    if ('title' in b) {
      if (!admin) throw new HttpError(403, 'Недостаточно прав');
      const title = str(b.title, 200);
      if (!title) throw new HttpError(400, 'Тема не может быть пустой');
      if (title !== cur.title) set('title', title);
    }
    if (sets.length) await db.query(`UPDATE tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  });
  await calendarSync.syncTicket(id, req.user.id);
  if (events.includes('status')) notify.statusChanged(id).catch(() => {});
  if (events.includes('assigned')) notify.assigned(id).catch(() => {});
  res.json(await loadTicket(id));
}));

router.post('/tickets/:id/comments', L.upload.array('files', 5), ah(async (req, res) => {
  const t = await loadTicket(intOrNull(req.params.id));
  const body = str(req.body.body, 20000);
  const internal = req.body.is_internal === 'true' || req.body.is_internal === '1';
  if (!body && !(req.files || []).length) throw new HttpError(400, 'Напишите комментарий или приложите файл');
  await tx(async (db) => {
    const { rows } = await db.query(
      'INSERT INTO comments (ticket_id, user_id, body, is_internal) VALUES ($1, $2, $3, $4) RETURNING id',
      [t.id, req.user.id, body || '(файл)', internal]);
    await L.saveAttachments(db, t.id, rows[0].id, req.files, me(req), internal);
    await db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
  });
  if (!internal) notify.staffCommented(t.id, body || '(приложен файл)').catch(() => {});
  res.status(201).json({ ok: true });
}));

router.delete('/tickets/:id', requireAdmin, ah(async (req, res) => {
  await calendarSync.removeTicketTask(intOrNull(req.params.id));
  const { rowCount } = await query('DELETE FROM tickets WHERE id = $1', [intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Заявка не найдена');
  res.json({ ok: true });
}));

router.get('/attachments/:id', ah(async (req, res) => {
  const { rows } = await query('SELECT filename, mime_type, data FROM attachments WHERE id = $1', [intOrNull(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Файл не найден');
  L.sendAttachment(res, rows[0]);
}));

// Поиск техники в инвентаре для привязки к заявке
router.get('/devices', ah(async (req, res) => {
  if (!atLeast(req.user, 'inventory', 'view')) return res.json([]);
  const term = `%${String(req.query.q || '').trim()}%`;
  const { rows } = await query(
    `SELECT d.id, dt.code || '-' || d.id AS key, dt.name AS type_name, d.hostname, d.inv_number,
            m.value AS model, e.value AS employee, l.value AS location
       FROM public.devices d JOIN public.device_types dt ON dt.id = d.type_id
       LEFT JOIN public.lookups m ON m.id = d.model_id
       LEFT JOIN public.lookups e ON e.id = d.employee_id
       LEFT JOIN public.lookups l ON l.id = d.location_id
      WHERE d.hostname ILIKE $1 OR d.inv_number ILIKE $1 OR d.serial_number ILIKE $1 OR d.ip_address ILIKE $1
         OR m.value ILIKE $1 OR e.value ILIKE $1 OR l.value ILIKE $1 OR (dt.code || '-' || d.id) ILIKE $1
      ORDER BY d.id LIMIT 20`, [term]);
  res.json(rows);
}));

// ---------- виды проблем ----------
function categoryBody(b) {
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, 'Укажите название');
  return [name, str(b.description, 500), str(b.icon, 8) || '🛠', Number(b.sort) || 0, b.is_active !== false,
    b.default_assignee_id ? Number(b.default_assignee_id) : null];
}
router.post('/categories', requireAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `INSERT INTO categories (name, description, icon, sort, is_active, default_assignee_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, categoryBody(req.body || {}));
  res.status(201).json(rows[0]);
}));
router.put('/categories/:id', requireAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `UPDATE categories SET name = $1, description = $2, icon = $3, sort = $4, is_active = $5,
            default_assignee_id = $6 WHERE id = $7 RETURNING *`,
    [...categoryBody(req.body || {}), intOrNull(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Не найдено');
  res.json(rows[0]);
}));
router.delete('/categories/:id', requireAdmin, ah(async (req, res) => {
  await query('DELETE FROM categories WHERE id = $1', [intOrNull(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- статусы ----------
function statusBody(b) {
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Укажите название');
  if (b.color && !HEX.test(b.color)) throw new HttpError(400, 'Цвет в формате #RRGGBB');
  return [name, b.color || '#8993A4', Number(b.sort) || 0, !!b.is_closed];
}
async function fixDefault(db, id, isDefault) {
  if (isDefault) await db.query('UPDATE statuses SET is_default = (id = $1)', [id]);
  // Статус по умолчанию должен быть всегда
  await db.query(`UPDATE statuses SET is_default = TRUE WHERE id = (SELECT id FROM statuses ORDER BY sort, id LIMIT 1)
                  AND NOT EXISTS (SELECT 1 FROM statuses WHERE is_default)`);
}
router.post('/statuses', requireAdmin, ah(async (req, res) => {
  const row = await tx(async (db) => {
    const { rows } = await db.query('INSERT INTO statuses (name, color, sort, is_closed) VALUES ($1, $2, $3, $4) RETURNING *',
      statusBody(req.body || {}));
    await fixDefault(db, rows[0].id, !!req.body.is_default);
    return rows[0];
  });
  res.status(201).json(row);
}));
router.put('/statuses/:id', requireAdmin, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await tx(async (db) => {
    const { rowCount } = await db.query('UPDATE statuses SET name = $1, color = $2, sort = $3, is_closed = $4 WHERE id = $5',
      [...statusBody(req.body || {}), id]);
    if (!rowCount) throw new HttpError(404, 'Не найдено');
    if (req.body.is_default) await fixDefault(db, id, true);
    else {
      await db.query('UPDATE statuses SET is_default = FALSE WHERE id = $1', [id]);
      await fixDefault(db, null, false);
    }
  });
  res.json({ ok: true });
}));
router.delete('/statuses/:id', requireAdmin, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const used = (await query('SELECT count(*)::int AS n FROM tickets WHERE status_id = $1', [id])).rows[0].n;
  if (used) throw new HttpError(400, `Статус используется в ${used} заявк(ах). Сначала переведите их в другой статус`);
  if ((await query('SELECT count(*)::int AS n FROM statuses')).rows[0].n <= 1) throw new HttpError(400, 'Нужен хотя бы один статус');
  await tx(async (db) => {
    await db.query('DELETE FROM statuses WHERE id = $1', [id]);
    await fixDefault(db, null, false);
  });
  res.json({ ok: true });
}));

// ---------- зарегистрированные сотрудники ----------
router.get('/requesters', requireAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.email, r.full_name, r.department, r.position, r.phone, r.room, r.is_active, r.is_approved,
            r.email_verified, r.created_at, r.last_login,
            count(t.id)::int AS tickets, count(t.id) FILTER (WHERE NOT s.is_closed)::int AS open_tickets
       FROM requesters r
       LEFT JOIN tickets t ON t.requester_id = r.id
       LEFT JOIN statuses s ON s.id = t.status_id
      GROUP BY r.id ORDER BY r.is_approved, r.created_at DESC`);
  res.json(rows);
}));
router.patch('/requesters/:id', requireAdmin, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const sets = [];
  const vals = [id];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if ('is_active' in b) set('is_active', !!b.is_active);
  if ('is_approved' in b) set('is_approved', !!b.is_approved);
  if (b.is_approved) set('email_verified', true);
  for (const k of ['full_name', 'position', 'phone', 'room']) if (k in b) set(k, str(b[k], 200));
  if ('department' in b || 'department_id' in b) {
    const dep = await L.resolveDepartment(b);
    set('department', dep.name); set('department_id', dep.id);
  }
  if (b.password) {
    if (String(b.password).length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
    set('password_hash', await bcrypt.hash(String(b.password), 10));
  }
  if (!sets.length) throw new HttpError(400, 'Нет изменений');
  const { rowCount } = await query(`UPDATE requesters SET ${sets.join(', ')} WHERE id = $1`, vals);
  if (!rowCount) throw new HttpError(404, 'Не найдено');
  if (b.is_active === false || b.password) {
    await query(`DELETE FROM helpdesk."session" WHERE (sess->>'requesterId')::int = $1`, [id]);
  }
  res.json({ ok: true });
}));
router.delete('/requesters/:id', requireAdmin, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  await query(`DELETE FROM helpdesk."session" WHERE (sess->>'requesterId')::int = $1`, [id]);
  await query('DELETE FROM requesters WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------- настройки регистрации ----------
router.put('/settings', requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  if ('allowed_domains' in b) {
    const list = Array.isArray(b.allowed_domains) ? b.allowed_domains.join(',') : b.allowed_domains;
    const domains = L.parseDomains(list);
    if (domains.some((d) => !/^[a-z0-9.-]+\.[a-z0-9-]+$|^[a-z0-9-]+$/.test(d))) throw new HttpError(400, 'Некорректный домен');
    await L.setSetting('allowed_domains', domains);
  }
  if ('require_approval' in b) await L.setSetting('require_approval', !!b.require_approval);
  if ('welcome_text' in b) await L.setSetting('welcome_text', String(b.welcome_text || '').slice(0, 2000));
  res.json(await L.getSettings());
}));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 10 МБ)' : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

module.exports = router;
