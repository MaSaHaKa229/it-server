// Заявки → календарь исполнителя (односторонняя синхронизация).
// Заявка с исполнителем = задача в календаре: тот же исполнитель, срок, приоритет, статус.
// Срок, исполнитель и статус меняются только в заявке — правки задачи в календаре
// при следующем изменении заявки перезаписываются.
const { poolFor } = require('../db');
const { syncUser } = require('../portal/sync');
const L = require('./lib');

const db = () => poolFor('public');
const CATEGORY = { name: 'Заявки', color: '#ff8b00' };

async function categoryId(c) {
  const { rows } = await c.query(
    `INSERT INTO calendar.categories (name, color) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [CATEGORY.name, CATEGORY.color]);
  return rows[0].id;
}

// Статус задачи по статусу заявки
function taskStatus(t) {
  if (t.is_closed) return /отклон|отмен|отозван/i.test(t.status_name) ? 'cancelled' : 'done';
  return t.is_default ? 'todo' : 'in_progress';
}

function description(t) {
  const who = [t.requester_name, t.requester_department].filter(Boolean).join(', ');
  const parts = [
    `Заявка #${t.id} от ${who}`,
    t.location ? `Место: ${t.location}` : null,
    t.requester_phone ? `Телефон: ${t.requester_phone}` : null,
    t.description ? '\n' + String(t.description).slice(0, 3000) : null,
    process.env.PORTAL_URL ? `\nОткрыть заявку: ${L.portalUrl()}/helpdesk/#/tickets/${t.id}` : null,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * Привести задачу в календаре в соответствие с заявкой.
 * actorId — кто изменил заявку (для журнала календаря). Ошибки не пробрасываются:
 * сбой синхронизации не должен мешать работе с заявкой.
 */
async function syncTicket(ticketId, actorId = null) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT t.*, s.name AS status_name, s.is_closed, s.is_default,
              r.full_name AS requester_name, r.department AS requester_department, r.phone AS requester_phone
         FROM helpdesk.tickets t
         JOIN helpdesk.statuses s ON s.id = t.status_id
         JOIN helpdesk.requesters r ON r.id = t.requester_id
        WHERE t.id = $1 FOR UPDATE OF t`, [ticketId]);
    const t = rows[0];
    if (!t) { await client.query('COMMIT'); return; }

    // Нет исполнителя — задачи в календаре нет
    if (!t.assignee_id) {
      await client.query('DELETE FROM calendar.tasks WHERE id = $1 OR helpdesk_ticket_id = $2', [t.calendar_task_id || 0, t.id]);
      await client.query('UPDATE helpdesk.tickets SET calendar_task_id = NULL WHERE id = $1', [t.id]);
      await client.query('COMMIT');
      return;
    }

    // Исполнитель должен быть в таблице пользователей календаря
    const u = (await client.query(
      'SELECT id, username, full_name, email, role, is_active, modules FROM users WHERE id = $1', [t.assignee_id])).rows[0];
    if (u) await syncUser(u);

    const title = `#${t.id} ${t.title}`.slice(0, 200);
    const status = taskStatus(t);
    const cat = await categoryId(client);
    const existing = (await client.query(
      `SELECT id, all_day FROM calendar.tasks WHERE id = $1 OR helpdesk_ticket_id = $2
        ORDER BY (id = $1) DESC LIMIT 1`, [t.calendar_task_id || 0, t.id])).rows[0];

    // Время: со сроком — час до срока; без срока — весь день назначения.
    // Задачу без срока, которую уже передвинули в календаре, не трогаем.
    const keepTime = !t.due_at && existing && existing.all_day;
    const allDay = !t.due_at;
    const START = (a, d) => `CASE WHEN ${a}::boolean THEN date_trunc('day', now()) ELSE ${d}::timestamptz - interval '1 hour' END`;
    const END = (a, d) => `CASE WHEN ${a}::boolean THEN date_trunc('day', now()) ELSE ${d}::timestamptz END`;

    let taskId;
    if (existing) {
      taskId = existing.id;
      const vals = [title, description(t), status, t.priority, cat, actorId, taskId];
      let timeSql = '';
      if (!keepTime) {
        vals.push(allDay, t.due_at);
        timeSql = `, start_at = ${START('$8', '$9')}, end_at = ${END('$8', '$9')}, all_day = $8`;
      }
      await client.query(
        `UPDATE calendar.tasks SET title = $1, description = $2, status = $3::calendar.task_status,
                priority = $4::calendar.task_priority, category_id = $5, updated_by = $6, updated_at = now()${timeSql}
          WHERE id = $7`, vals);
    } else {
      const ins = await client.query(
        `INSERT INTO calendar.tasks (title, description, start_at, end_at, all_day, status, priority, category_id,
                                     created_by, updated_by, helpdesk_ticket_id)
         VALUES ($1, $2, ${START('$3', '$4')}, ${END('$3', '$4')}, $3,
                 $5::calendar.task_status, $6::calendar.task_priority, $7, $8, $8, $9)
         RETURNING id`,
        [title, description(t), allDay, t.due_at, status, t.priority, cat, actorId, t.id]);
      taskId = ins.rows[0].id;
      await client.query(
        `INSERT INTO calendar.activity_log (user_id, action, entity, entity_id, details)
         VALUES ($1, 'create', 'task', $2, $3)`, [actorId, taskId, JSON.stringify({ title, helpdesk_ticket: t.id })]);
    }
    await client.query('DELETE FROM calendar.task_assignees WHERE task_id = $1', [taskId]);
    await client.query('INSERT INTO calendar.task_assignees (task_id, user_id) VALUES ($1, $2)', [taskId, t.assignee_id]);
    if (t.calendar_task_id !== taskId) {
      await client.query('UPDATE helpdesk.tickets SET calendar_task_id = $2 WHERE id = $1', [t.id, taskId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Заявка #${ticketId}: не удалось обновить задачу в календаре:`, e.message);
  } finally {
    client.release();
  }
}

/** Перед удалением заявки — удалить её задачу */
async function removeTicketTask(ticketId) {
  try {
    await db().query(
      `DELETE FROM calendar.tasks WHERE id = (SELECT calendar_task_id FROM helpdesk.tickets WHERE id = $1)
          OR helpdesk_ticket_id = $1`, [ticketId]);
  } catch (e) {
    console.error(`Заявка #${ticketId}: не удалось удалить задачу в календаре:`, e.message);
  }
}

/** Однократный перенос: открытые заявки с исполнителем, у которых ещё нет задачи */
async function backfill() {
  const { rows } = await db().query(
    `SELECT t.id FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id
      WHERE t.assignee_id IS NOT NULL AND t.calendar_task_id IS NULL AND NOT s.is_closed
        AND NOT EXISTS (SELECT 1 FROM calendar.tasks ct WHERE ct.helpdesk_ticket_id = t.id)`);
  for (const r of rows) await syncTicket(r.id);
  return rows.length;
}

module.exports = { syncTicket, removeTicketTask, backfill };
