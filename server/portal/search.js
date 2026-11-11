// Общий поиск по порталу (поле в шапке): техника, заявки, задачи, документы — с учётом прав пользователя.
const express = require('express');
const { query } = require('../inventory/db');
const { perms, canSeeField } = require('../inventory/access');
const { ah } = require('../inventory/util');
const { level } = require('./modules');
const { calRole } = require('./sync');

const router = express.Router();
router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' })));

const LIMIT = 8;
const likeOf = (q) => `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

async function devices(u, q) {
  if (level(u, 'inventory') === 'none') return null;
  const P = perms(u);
  const vals = [likeOf(q)];
  const or = ['d.hostname ILIKE $1', 'd.inv_number ILIKE $1', 'lm.value ILIKE $1', "(t.code || '-' || d.id) ILIKE $1"];
  if (canSeeField(P, 'serial_number')) or.push('d.serial_number ILIKE $1');
  if (canSeeField(P, 'ip_address')) or.push('d.ip_address ILIKE $1');
  if (canSeeField(P, 'mac_address')) or.push('d.mac_address ILIKE $1');
  if (canSeeField(P, 'employee')) or.push('le.value ILIKE $1');
  const where = [`(${or.join(' OR ')})`];
  if (P.types !== null) { vals.push(P.types); where.push(`d.type_id = ANY($${vals.length}::int[])`); }
  if (P.departments !== null) { vals.push(P.departments); where.push(`d.department_id = ANY($${vals.length}::int[])`); }
  const { rows } = await query(
    `SELECT d.id, t.code, t.name AS type_name, d.hostname, d.inv_number, lm.value AS model,
            ${canSeeField(P, 'employee') ? 'le.value' : 'NULL'} AS employee, ll.value AS location, d.status
       FROM devices d JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups le ON le.id = d.employee_id
       LEFT JOIN lookups ll ON ll.id = d.location_id
      WHERE ${where.join(' AND ')}
      ORDER BY (d.status = 'written_off'), d.hostname NULLS LAST, d.id LIMIT ${LIMIT + 1}`, vals);
  return rows.map((r) => ({
    title: `${r.code}-${r.id} ${r.hostname || r.model || r.type_name}`,
    text: [r.model && r.hostname ? r.model : '', r.inv_number ? `инв. ${r.inv_number}` : '', r.employee, r.location,
      r.status === 'written_off' ? 'списано' : ''].filter(Boolean).join(' · '),
    link: `/inventory/#/devices/${r.id}`,
  }));
}

async function tickets(u, q) {
  if (!['executor', 'admin'].includes(level(u, 'helpdesk'))) return null;
  const num = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : 0;
  const { rows } = await query(
    `SELECT t.id, t.title, s.name AS status, s.is_closed, r.full_name AS requester, t.created_at
       FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id JOIN helpdesk.requesters r ON r.id = t.requester_id
      WHERE t.id = $2 OR t.title ILIKE $1 OR t.description ILIKE $1 OR r.full_name ILIKE $1 OR t.location ILIKE $1
      ORDER BY (t.id = $2) DESC, s.is_closed, t.created_at DESC LIMIT ${LIMIT + 1}`, [likeOf(q), num]);
  return rows.map((r) => ({
    title: `#${r.id} ${r.title}`,
    text: [r.status, r.requester, new Date(r.created_at).toLocaleDateString('ru-RU')].join(' · '),
    link: `/helpdesk/#/tickets/${r.id}`, muted: r.is_closed,
  }));
}

async function tasks(u, q) {
  if (level(u, 'calendar') === 'none') return null;
  const { scopeOf, taskCond } = await import('../calendar/scope.js');
  const vals = [likeOf(q)];
  const cond = (taskCond({ id: u.id, scope: scopeOf(u, calRole(u)) }, vals) || 'TRUE').replace(/task_assignees/g, 'calendar.task_assignees');
  const { rows } = await query(
    `SELECT t.id, t.title, t.start_at, t.all_day, t.status, c.name AS category
       FROM calendar.tasks t LEFT JOIN calendar.categories c ON c.id = t.category_id
      WHERE (t.title ILIKE $1 OR t.description ILIKE $1) AND ${cond}
      ORDER BY (t.status IN ('done', 'cancelled')), abs(extract(epoch FROM (t.start_at - now()))) LIMIT ${LIMIT + 1}`, vals);
  const ST = { todo: 'к выполнению', in_progress: 'в работе', done: 'выполнена', cancelled: 'отменена' };
  return rows.map((r) => ({
    title: r.title,
    text: [new Date(r.start_at).toLocaleDateString('ru-RU'), ST[r.status], r.category].filter(Boolean).join(' · '),
    link: `/calendar/#/calendar?task=${r.id}`, muted: ['done', 'cancelled'].includes(r.status),
  }));
}

async function documents(u, q) {
  if (level(u, 'docs') === 'none') return null;
  const { allowedFolderIds } = require('../docs/access');
  const m = u.modules || {};
  const types = u.role === 'superadmin' || !Array.isArray(m.docs_types) || !m.docs_types.length ? null : m.docs_types;
  const folders = await allowedFolderIds(u);
  const vals = [likeOf(q), q];
  const where = [`(d.title ILIKE $1 OR d.number ILIKE $1 OR d.title_tsv @@ websearch_to_tsquery('russian', $2))`];
  if (types) { vals.push(types); where.push(`d.doc_type = ANY($${vals.length}::text[])`); }
  if (folders) { vals.push(folders); where.push(`d.folder_id = ANY($${vals.length}::int[])`); }
  const { rows } = await query(
    `SELECT d.id, d.title, d.number, d.adopted_at, dt.name AS type_name
       FROM docs.documents d LEFT JOIN docs.doc_types dt ON dt.code = d.doc_type
      WHERE ${where.join(' AND ')}
      ORDER BY (d.title ILIKE $1) DESC, d.updated_at DESC LIMIT ${LIMIT + 1}`, vals);
  return rows.map((r) => ({
    title: r.title,
    text: [r.type_name, r.number ? `№ ${r.number}` : '', r.adopted_at ? new Date(r.adopted_at).toLocaleDateString('ru-RU') : ''].filter(Boolean).join(' · '),
    link: `/docs/documents/${r.id}`,
  }));
}

const SECTIONS = [
  ['devices', 'Техника', devices, (q) => `/inventory/#/devices?q=${encodeURIComponent(q)}`],
  ['tickets', 'Заявки', tickets, null],
  ['tasks', 'Задачи', tasks, null],
  ['documents', 'Документы', documents, (q) => `/docs/?q=${encodeURIComponent(q)}`],
];

router.get('/', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ sections: [] });
  const u = req.user;
  const out = await Promise.all(SECTIONS.map(async ([key, label, fn, more]) => {
    try {
      const items = await fn(u, q);
      if (!items) return null;
      return { key, label, items: items.slice(0, LIMIT), more: items.length > LIMIT && more ? more(q) : null };
    } catch (e) {
      console.error(`Поиск (${label}):`, e.message);
      return null;
    }
  }));
  res.json({ sections: out.filter(Boolean) });
}));

module.exports = router;
