// Предпросмотр по наведению: короткая карточка техники, заявки, задачи или документа (с учётом прав).
const express = require('express');
const { query } = require('../inventory/db');
const { perms, canSeeField } = require('../inventory/access');
const { ah, HttpError } = require('../inventory/util');
const { level } = require('./modules');
const { calRole } = require('./sync');

const router = express.Router();
router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' })));

const day = (d) => (d ? new Date(d).toLocaleDateString('ru-RU') : '');
const dt = (d) => (d ? new Date(d).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function device(u, id) {
  if (level(u, 'inventory') === 'none') return null;
  const P = perms(u);
  const vals = [id];
  const w = [];
  if (P.types !== null) { vals.push(P.types); w.push(`d.type_id = ANY($${vals.length}::int[])`); }
  if (P.departments !== null) { vals.push(P.departments); w.push(`d.department_id = ANY($${vals.length}::int[])`); }
  const { rows: [d] } = await query(
    `SELECT d.id, t.code, t.name AS type_name, t.color, d.hostname, d.inv_number, d.ip_address, d.serial_number, d.status, st.label AS status_label,
            st.color AS status_color, lm.value AS model, le.value AS employee, ll.value AS location, ld.value AS department, wp.name AS workplace
       FROM devices d JOIN device_types t ON t.id = d.type_id LEFT JOIN device_statuses st ON st.key = d.status
       LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups le ON le.id = d.employee_id
       LEFT JOIN lookups ll ON ll.id = d.location_id LEFT JOIN lookups ld ON ld.id = d.department_id
       LEFT JOIN workplaces wp ON wp.id = d.workplace_id
      WHERE d.id = $1 ${w.length ? 'AND ' + w.join(' AND ') : ''}`, vals);
  if (!d) return null;
  const f = (key, label, v) => (canSeeField(P, key) && v ? [label, v] : null);
  return {
    kind: 'Техника', title: `${d.code}-${d.id} ${d.hostname || d.model || d.type_name}`, color: d.color,
    badge: { text: d.status_label || d.status, color: d.status_color },
    rows: [f('model', 'Модель', d.model), f('employee', 'Пользователь', d.employee), f('location', 'Расположение', d.location),
      f('department', 'Отдел', d.department), ['Рабочее место', d.workplace], f('inv_number', 'Инв. №', d.inv_number),
      f('ip_address', 'IP', d.ip_address), f('serial_number', 'Серийный №', d.serial_number)].filter((x) => x && x[1]),
  };
}

async function ticket(u, id) {
  if (!['executor', 'admin'].includes(level(u, 'helpdesk'))) return null;
  const { rows: [t] } = await query(
    `SELECT t.id, t.title, t.priority, t.due_at, t.created_at, s.name AS status, s.color AS status_color, c.name AS category,
            r.full_name AS requester, COALESCE(l.value, r.department) AS department, t.location,
            CASE WHEN u.is_service THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS assignee,
            left(t.description, 200) AS description
       FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id JOIN helpdesk.requesters r ON r.id = t.requester_id
       LEFT JOIN helpdesk.categories c ON c.id = t.category_id LEFT JOIN public.lookups l ON l.id = r.department_id
       LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1`, [id]);
  if (!t) return null;
  const PR = { low: 'низкий', normal: 'обычный', high: 'высокий', critical: 'критический' };
  return {
    kind: 'Заявка', title: `#${t.id} ${t.title}`, badge: { text: t.status, color: t.status_color },
    rows: [['Вид', t.category], ['Заявитель', [t.requester, t.department].filter(Boolean).join(', ')], ['Место', t.location],
      ['Исполнитель', t.assignee || 'не назначен'], ['Приоритет', PR[t.priority]], ['Срок', dt(t.due_at)], ['Создана', dt(t.created_at)]]
      .filter((x) => x[1]),
    text: t.description || '',
  };
}

async function task(u, id) {
  if (level(u, 'calendar') === 'none') return null;
  const { scopeOf, taskCond } = await import('../calendar/scope.js');
  const vals = [id];
  const cond = (taskCond({ id: u.id, scope: scopeOf(u, calRole(u)) }, vals) || 'TRUE').replace(/task_assignees/g, 'calendar.task_assignees');
  const { rows: [t] } = await query(
    `SELECT t.id, t.title, t.start_at, t.end_at, t.all_day, t.status, t.priority, c.name AS category, c.color,
            left(t.description, 200) AS description,
            (SELECT string_agg(x.name, ', ' ORDER BY x.name) FROM calendar.task_assignees a JOIN calendar.users x ON x.id = a.user_id
              WHERE a.task_id = t.id AND NOT x.is_system) AS assignees
       FROM calendar.tasks t LEFT JOIN calendar.categories c ON c.id = t.category_id WHERE t.id = $1 AND ${cond}`, vals);
  if (!t) return null;
  const ST = { todo: ['к выполнению', '#6B778C'], in_progress: ['в работе', '#0052CC'], done: ['выполнена', '#36B37E'], cancelled: ['отменена', '#97A0AF'] };
  return {
    kind: 'Задача', title: t.title, color: t.color, badge: { text: ST[t.status][0], color: ST[t.status][1] },
    rows: [['Когда', t.all_day ? `${day(t.start_at)} — ${day(t.end_at)}` : `${dt(t.start_at)} — ${dt(t.end_at)}`],
      ['Исполнители', t.assignees || 'не назначены'], ['Категория', t.category]].filter((x) => x[1]),
    text: t.description || '',
  };
}

async function documentPeek(u, id) {
  if (level(u, 'docs') === 'none') return null;
  const { allowedFolderIds } = require('../docs/access');
  const m = u.modules || {};
  const types = u.role === 'superadmin' || !Array.isArray(m.docs_types) || !m.docs_types.length ? null : m.docs_types;
  const folders = await allowedFolderIds(u);
  const vals = [id];
  const w = [];
  if (types) { vals.push(types); w.push(`d.doc_type = ANY($${vals.length}::text[])`); }
  if (folders) { vals.push(folders); w.push(`d.folder_id = ANY($${vals.length}::int[])`); }
  const { rows: [d] } = await query(
    `SELECT d.id, d.title, d.number, d.adopted_at, d.status, dt.name AS type_name, f.name AS folder, left(d.content, 220) AS content
       FROM docs.documents d LEFT JOIN docs.doc_types dt ON dt.code = d.doc_type LEFT JOIN docs.folders f ON f.id = d.folder_id
      WHERE d.id = $1 ${w.length ? 'AND ' + w.join(' AND ') : ''}`, vals);
  if (!d) return null;
  const ST = { active: ['действует', '#36B37E'], inactive: ['утратил силу', '#97A0AF'], draft: ['проект', '#FF8B00'] };
  return {
    kind: 'Документ', title: d.title, badge: ST[d.status] ? { text: ST[d.status][0], color: ST[d.status][1] } : null,
    rows: [['Вид', d.type_name], ['Номер', d.number], ['Дата', day(d.adopted_at)], ['Папка', d.folder]].filter((x) => x[1]),
    text: (d.content || '').replace(/\s+/g, ' ').trim(),
  };
}

const KINDS = { device, ticket, task, document: documentPeek };

router.get('/', ah(async (req, res) => {
  const fn = KINDS[req.query.kind];
  const id = Number(req.query.id);
  if (!fn || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Неверный запрос');
  const r = await fn(req.user, id);
  if (!r) throw new HttpError(404, 'Нет данных');
  res.json(r);
}));

module.exports = router;
