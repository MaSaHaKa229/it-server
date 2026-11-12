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
// Журнал действий администратора helpdesk
router.use(require('../portal/audit').trackChanges([
  [/^\/categories(\/|$)/, 'hd_category'], [/^\/statuses(\/|$)/, 'hd_status'],
  [/^\/requesters(\/|$)/, 'hd_requester'], [/^\/settings$/, 'hd_settings'],
]));
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
  const [statuses, categories, execs, settings, departments] = await Promise.all([
    query('SELECT * FROM statuses ORDER BY sort, id'),
    query(`SELECT c.*, CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS default_assignee_name,
                  (SELECT count(*)::int FROM tickets t WHERE t.category_id = c.id) AS ticket_count
             FROM categories c LEFT JOIN public.users u ON u.id = c.default_assignee_id ORDER BY c.sort, c.name`),
    executors(),
    L.getSettings(),
    L.departments(),
  ]);
  res.json({
    me: { id: req.user.id, name: req.user.full_name || req.user.username, isAdmin: isAdmin(req),
      inventory: level(req.user, 'inventory') !== 'none' },
    statuses: statuses.rows, categories: categories.rows, executors: execs, priorities: L.PRIORITIES, departments,
    settings, mailEnabled: L.mailEnabled(), helpdeskUrl: L.helpdeskUrl(),
  });
}));

// ---------- список заявок ----------
/** Условия отбора списка заявок (общие для списка и выгрузки в Excel) */
function ticketFilters(req) {
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
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', vals, sort };
}

router.get('/tickets', ah(async (req, res) => {
  const { where, vals, sort } = ticketFilters(req);
  const limit = Math.min(Number(req.query.limit) || 300, 5000);
  const { rows } = await query(`${L.TICKET_SELECT} ${where} ORDER BY ${sort} LIMIT ${limit}`, vals);
  const counts = (await query(
    `SELECT count(*) FILTER (WHERE NOT s.is_closed)::int AS open,
            count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id = $1)::int AS mine,
            count(*) FILTER (WHERE NOT s.is_closed AND t.assignee_id IS NULL)::int AS unassigned,
            count(*) FILTER (WHERE NOT s.is_closed AND t.due_at < now())::int AS overdue
       FROM tickets t JOIN statuses s ON s.id = t.status_id`, [req.user.id])).rows[0];
  res.json({ tickets: rows.map(({ description, ...t }) => t), counts });
}));

// Выгрузка списка заявок в Excel (с теми же отборами, что на экране)
router.get('/tickets/export.xlsx', ah(async (req, res) => {
  const ExcelJS = require('exceljs');
  const { where, vals, sort } = ticketFilters(req);
  const { rows } = await query(`${L.TICKET_SELECT} ${where} ORDER BY ${sort} LIMIT 20000`, vals);
  const CH = { web: 'сайт заявок', phone: 'по телефону', visit: 'лично', email: 'по почте', other: 'другое' };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Заявки', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '№', key: 'id', width: 7 }, { header: 'Тема', key: 'title', width: 40 }, { header: 'Вид', key: 'category_name', width: 20 },
    { header: 'Приоритет', key: 'priority', width: 12 }, { header: 'Статус', key: 'status_name', width: 14 },
    { header: 'Заявитель', key: 'requester_name', width: 24 }, { header: 'Отдел', key: 'requester_department', width: 22 },
    { header: 'Телефон', key: 'requester_phone', width: 12 }, { header: 'Место', key: 'location', width: 14 },
    { header: 'Исполнитель', key: 'assignee_name', width: 22 }, { header: 'Как поступила', key: 'channel', width: 14 },
    { header: 'Создана', key: 'created_at', width: 17 }, { header: 'Срок', key: 'due_at', width: 17 }, { header: 'Закрыта', key: 'closed_at', width: 17 },
    { header: 'Описание', key: 'description', width: 50 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  for (const t of rows) {
    ws.addRow({ ...t, priority: L.PRIORITIES[t.priority] || t.priority, channel: CH[t.channel] || t.channel,
      due_at: t.due_at || '', closed_at: t.closed_at || '', description: String(t.description || '').slice(0, 2000) });
  }
  ['created_at', 'due_at', 'closed_at'].forEach((k) => { ws.getColumn(k).numFmt = 'dd.mm.yyyy hh:mm'; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 15 } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="helpdesk-tickets.xlsx"');
  await wb.xlsx.write(res);
  res.end();
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
    query(
      `SELECT d.id, dt.code || '-' || d.id AS key, dt.name AS type_name, d.hostname, d.inv_number, d.ip_address,
              m.value AS model, e.value AS employee
         FROM public.devices d JOIN public.device_types dt ON dt.id = d.type_id
         LEFT JOIN public.lookups m ON m.id = d.model_id
         LEFT JOIN public.lookups e ON e.id = d.employee_id
         JOIN ticket_devices td ON td.device_id = d.id
        WHERE td.ticket_id = $1 ORDER BY td.added_at, d.id`, [t.id]),
    query(`SELECT count(*)::int AS total FROM tickets WHERE requester_id = $1`, [t.requester_id]),
  ]);
  res.json({
    ...t, comments: comments.rows, attachments: files.rows, history: history.rows,
    devices: device.rows, device: device.rows[0] || null, requester_ticket_count: reqStats.rows[0].total,
  });
}));

// ---------- заявка от службы ИТ за сотрудника (звонок, пришёл лично, письмо) ----------
const CHANNELS = { phone: 'по телефону', visit: 'лично', email: 'по почте', other: 'со слов сотрудника' };

// Поиск заявителя (для всех сотрудников helpdesk)
router.get('/requesters/search', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const { rows } = await query(
    `SELECT r.id, r.full_name, CASE WHEN r.email LIKE '%.invalid' THEN '' ELSE r.email END AS email,
            COALESCE(l.value, r.department) AS department, r.department_id, r.phone, r.room, r.is_active
       FROM requesters r LEFT JOIN public.lookups l ON l.id = r.department_id
      WHERE r.full_name ILIKE $1 OR r.email ILIKE $1 OR r.phone ILIKE $1 OR r.room ILIKE $1 OR COALESCE(l.value, r.department) ILIKE $1
      ORDER BY r.is_active DESC, r.full_name LIMIT 20`, [`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`]);
  res.json(rows);
}));

/** Найти или создать заявителя по данным из формы службы ИТ */
async function requesterFor(db, b) {
  if (intOrNull(b.requester_id)) {
    const r = (await db.query('SELECT * FROM requesters WHERE id = $1', [intOrNull(b.requester_id)])).rows[0];
    if (!r) throw new HttpError(400, 'Сотрудник не найден');
    return r;
  }
  const n = b.requester || {};
  const fullName = str(n.full_name, 200);
  if (!fullName) throw new HttpError(400, 'Укажите сотрудника: выберите из списка или впишите ФИО');
  // E-mail обязателен: по нему сотрудник потом сам зарегистрируется на сайте заявок и получит эту же учётную запись
  // со всеми заявками (а не заведёт вторую)
  const email = (str(n.email, 200) || '').toLowerCase();
  if (!email) throw new HttpError(400, 'Укажите рабочий e-mail сотрудника');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Некорректный e-mail');
  const ex = (await db.query('SELECT * FROM requesters WHERE lower(email) = $1', [email])).rows[0];
  if (ex) return ex;
  const domains = (await L.getSettings()).allowed_domains || [];
  if (domains.length && !domains.includes(email.split('@')[1])) {
    throw new HttpError(400, `E-mail должен быть рабочим: ${domains.map((d) => '@' + d).join(', ')}`);
  }
  const dep = await L.resolveDepartment({ department_id: n.department_id, department: n.department });
  const addr = email;
  const hash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
  const { rows } = await db.query(
    `INSERT INTO requesters (email, full_name, department, department_id, phone, room, password_hash, is_active, is_approved, email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, false) RETURNING *`,
    [addr, fullName, dep ? dep.name : null, dep ? dep.id : null, str(n.phone, 50), str(n.room, 100), hash]);
  return rows[0];
}

router.post('/tickets', ah(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Кратко опишите проблему в поле «Тема»');
  const admin = isAdmin(req);
  const priority = L.PRIORITIES[b.priority] ? b.priority : 'normal';
  const channel = CHANNELS[b.channel] ? b.channel : 'phone';
  const id = await tx(async (db) => {
    const rq = await requesterFor(db, b);
    const cat = intOrNull(b.category_id) ? (await db.query('SELECT * FROM categories WHERE id = $1', [intOrNull(b.category_id)])).rows[0] : null;
    if (intOrNull(b.category_id) && !cat) throw new HttpError(400, 'Вид проблемы не найден');
    const st = (await db.query('SELECT id FROM statuses ORDER BY is_default DESC, sort, id LIMIT 1')).rows[0];
    // Исполнитель: «себе», выбранный администратором или по правилам автоназначения
    let assignee = null;
    let assigneeName = null;
    let auto = false;
    let how = null;
    if (b.assignee === 'me') { assignee = req.user.id; assigneeName = req.user.role === 'superadmin' ? 'Служба ИТ' : (req.user.full_name || req.user.username); }
    else if (/^\d+$/.test(String(b.assignee)) && admin) {
      const ex = (await executors()).find((x) => x.id === Number(b.assignee));
      if (!ex) throw new HttpError(400, 'Этот пользователь не может быть исполнителем');
      assignee = ex.id; assigneeName = ex.name;
    } else if (b.assignee !== 'none') {
      const p = await require('./autoassign').pick(db, { category: cat, departmentId: rq.department_id || null });
      if (p) { assignee = p.assigneeId; assigneeName = p.name; auto = true; how = p.how; }
    }
    // Срок: администратор может указать; иначе — нормативный срок вида проблемы
    let due = null;
    let dueAuto = false;
    if (admin && b.due_at) {
      due = new Date(b.due_at);
      if (Number.isNaN(due.getTime())) throw new HttpError(400, 'Некорректный срок');
    } else if (cat && cat.sla_hours) { due = L.slaDue(cat); dueAuto = true; }
    const { rows } = await db.query(
      `INSERT INTO tickets (requester_id, category_id, status_id, priority, title, description, location, assignee_id, due_at, due_auto, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [rq.id, cat ? cat.id : null, st.id, priority, title, str(b.description, 20000) || '', str(b.location, 200) || rq.room, assignee, due, dueAuto, channel]);
    const tid = rows[0].id;
    await L.addHistory(db, tid, me(req), 'created', { staff: true, channel: CHANNELS[channel] });
    if (assignee) await L.addHistory(db, tid, me(req), 'assignee', { from: null, to: assigneeName, auto, how });
    if (due) await L.addHistory(db, tid, me(req), 'due', { from: null, to: due, auto: dueAuto });
    return tid;
  });
  await calendarSync.syncTicket(id, req.user.id);
  notify.ticketCreated(id, req.user.id).catch(() => {});
  res.status(201).json({ id });
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
        await L.addHistory(db, id, me(req), 'assignee', { from: null, to: req.user.role === 'superadmin' ? 'Служба ИТ' : (req.user.full_name || req.user.username) });
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
      if (cur.due_auto) set('due_auto', false);
    }
    // Подтвердить срок, поставленный по нормативу
    if (b.confirm_due && cur.due_auto) {
      if (!admin) throw new HttpError(403, 'Сроки подтверждает администратор helpdesk');
      set('due_auto', false);
      await L.addHistory(db, id, me(req), 'due_confirmed', { to: cur.due_at });
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
        // Срок по нормативу ещё не подтверждён — пересчитать по новому виду проблемы
        if ((cur.due_auto || !cur.due_at) && !('due_at' in b)) {
          const nc = to ? (await db.query('SELECT sla_hours FROM categories WHERE id = $1', [to])).rows[0] : null;
          const nd = L.slaDue(nc, cur.created_at);
          if ((nd ? nd.getTime() : null) !== (cur.due_at ? cur.due_at.getTime() : null)) {
            set('due_at', nd); set('due_auto', !!nd);
            await L.addHistory(db, id, me(req), 'due', { from: cur.due_at, to: nd, auto: true });
          }
        }
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
  if (events.includes('assigned')) notify.assigned(id, req.user.id).catch(() => {});
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

// ---------- техника из инвентаря, привязанная к заявке ----------
// Привязывать и отвязывать может исполнитель заявки (или берущий свободную) и администратор helpdesk —
// доступ к разделу «ИТ-инвентарь» для этого не нужен. Каждое действие пишется в историю заявки и техники.
const deviceLabel = (d) => `${d.code}-${d.id}${d.hostname ? ' ' + d.hostname : d.inv_number ? ' ' + d.inv_number : ''}`;

async function linkDevice(req, ticketId, deviceId, add) {
  const admin = isAdmin(req);
  return tx(async (db) => {
    const t = (await db.query('SELECT id, title, assignee_id, device_id FROM tickets WHERE id = $1 FOR UPDATE', [ticketId])).rows[0];
    if (!t) throw new HttpError(404, 'Заявка не найдена');
    if (!admin && t.assignee_id !== null && t.assignee_id !== req.user.id) {
      throw new HttpError(403, 'Технику привязывает исполнитель заявки или администратор helpdesk');
    }
    const d = (await db.query(
      `SELECT d.id, d.hostname, d.inv_number, dt.code FROM public.devices d JOIN public.device_types dt ON dt.id = d.type_id WHERE d.id = $1`,
      [deviceId])).rows[0];
    if (!d) throw new HttpError(404, 'Устройство не найдено');
    const label = deviceLabel(d);
    const ticketText = `#${t.id} ${t.title}`.slice(0, 300);
    if (add) {
      const r = await db.query(
        'INSERT INTO ticket_devices (ticket_id, device_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [t.id, d.id, req.user.id]);
      if (!r.rowCount) return false;
      if (!t.device_id) await db.query('UPDATE tickets SET device_id = $2 WHERE id = $1', [t.id, d.id]);
      await L.addHistory(db, t.id, me(req), 'device', { added: label });
      await db.query(`INSERT INTO public.device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'ticket_linked', $3)`,
        [d.id, req.user.id, JSON.stringify({ 'Заявка': [null, ticketText] })]);
    } else {
      const r = await db.query('DELETE FROM ticket_devices WHERE ticket_id = $1 AND device_id = $2', [t.id, d.id]);
      if (!r.rowCount) return false;
      if (t.device_id === d.id) {
        await db.query('UPDATE tickets SET device_id = (SELECT device_id FROM ticket_devices WHERE ticket_id = $1 ORDER BY added_at LIMIT 1) WHERE id = $1', [t.id]);
      }
      await L.addHistory(db, t.id, me(req), 'device', { removed: label });
      await db.query(`INSERT INTO public.device_history (device_id, user_id, action, changes) VALUES ($1, $2, 'ticket_unlinked', $3)`,
        [d.id, req.user.id, JSON.stringify({ 'Заявка': [ticketText, null] })]);
    }
    return true;
  });
}

router.post('/tickets/:id/devices', ah(async (req, res) => {
  const ok = await linkDevice(req, intOrNull(req.params.id), intOrNull(req.body.device_id), true);
  res.json({ ok, already: !ok });
}));
router.delete('/tickets/:id/devices/:deviceId', ah(async (req, res) => {
  await linkDevice(req, intOrNull(req.params.id), intOrNull(req.params.deviceId), false);
  res.json({ ok: true });
}));

// Поиск техники в инвентаре для привязки к заявке (исполнителям — без доступа к инвентарю)
router.get('/devices', ah(async (req, res) => {
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
  const sla = Math.round(Number(b.sla_hours)) || null;
  if (sla !== null && (sla < 1 || sla > 24 * 365)) throw new HttpError(400, 'Нормативный срок — от 1 часа до года');
  return [name, str(b.description, 500), str(b.icon, 8) || '🛠', Number(b.sort) || 0, b.is_active !== false,
    b.default_assignee_id ? Number(b.default_assignee_id) : null, sla];
}
router.post('/categories', requireAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `INSERT INTO categories (name, description, icon, sort, is_active, default_assignee_id, sla_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, categoryBody(req.body || {}));
  res.status(201).json(rows[0]);
}));
router.put('/categories/:id', requireAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `UPDATE categories SET name = $1, description = $2, icon = $3, sort = $4, is_active = $5,
            default_assignee_id = $6, sla_hours = $7 WHERE id = $8 RETURNING *`,
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

// ---------- отчёты (все сотрудники helpdesk) ----------
router.use('/reports', require('./reports'));

// ---------- правила автоназначения (администратор helpdesk) ----------
const audit = require('../portal/audit');
const RULES_SQL = `
  SELECT r.*, c.name AS category_name, l.value AS department_name,
         CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS assignee_name
    FROM assign_rules r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN public.lookups l ON l.id = r.department_id
    LEFT JOIN public.users u ON u.id = r.assignee_id`;

router.get('/rules', requireAdmin, ah(async (req, res) => {
  const [rules, deps] = await Promise.all([
    query(`${RULES_SQL} ORDER BY r.sort, r.id`),
    query(`SELECT id, value FROM public.lookups WHERE kind = 'department' ORDER BY value`),
  ]);
  res.json({ rules: rules.rows, departments: deps.rows });
}));

function ruleBody(b) {
  const mode = b.mode === 'least_loaded' ? 'least_loaded' : 'user';
  const assignee = mode === 'user' ? intOrNull(b.assignee_id) : null;
  if (mode === 'user' && !assignee) throw new HttpError(400, 'Выберите исполнителя');
  const pool = Array.isArray(b.pool) ? [...new Set(b.pool.map(Number).filter((n) => n > 0))] : [];
  return [intOrNull(b.category_id), intOrNull(b.department_id), mode, assignee, pool, Number(b.sort) || 0, b.is_active !== false];
}

router.post('/rules', requireAdmin, ah(async (req, res) => {
  const v = ruleBody(req.body || {});
  const { rows } = await query(
    `INSERT INTO assign_rules (category_id, department_id, mode, assignee_id, pool, sort, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, v);
  await audit.log(req, 'hd_rule', 'создано', { id: rows[0].id });
  res.status(201).json({ id: rows[0].id });
}));

router.put('/rules/:id', requireAdmin, ah(async (req, res) => {
  const v = ruleBody(req.body || {});
  const { rowCount } = await query(
    `UPDATE assign_rules SET category_id = $1, department_id = $2, mode = $3, assignee_id = $4, pool = $5, sort = $6, is_active = $7
      WHERE id = $8`, [...v, intOrNull(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Правило не найдено');
  await audit.log(req, 'hd_rule', 'изменено', { id: intOrNull(req.params.id) });
  res.json({ ok: true });
}));

router.delete('/rules/:id', requireAdmin, ah(async (req, res) => {
  await query('DELETE FROM assign_rules WHERE id = $1', [intOrNull(req.params.id)]);
  await audit.log(req, 'hd_rule', 'удалено', { id: intOrNull(req.params.id) });
  res.json({ ok: true });
}));

// Проверка: кому ушла бы заявка с таким видом и отделом
router.post('/rules/test', requireAdmin, ah(async (req, res) => {
  const cat = intOrNull(req.body.category_id)
    ? (await query('SELECT * FROM categories WHERE id = $1', [intOrNull(req.body.category_id)])).rows[0] : null;
  const r = await require('./autoassign').pick({ query }, { category: cat || null, departmentId: intOrNull(req.body.department_id) });
  res.json(r || { assigneeId: null });
}));

module.exports = router;
