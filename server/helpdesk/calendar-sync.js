// Заявки ↔ календарь. Из заявки в задачу переносится всё (название, срок, исполнитель, статус);
// из задачи в заявку — только статус (fromTask): выполнил задачу — заявка закрыта, вернул в работу — открыта.
// Каждая заявка = задача в календаре (категория «Заявки»). Пока исполнителя нет — задача без исполнителя
// на день создания; после назначения — у исполнителя, на срок или на день назначения.
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
    t.assignee_id ? null : 'Исполнитель ещё не назначен',
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

    // Исполнитель должен быть в таблице пользователей календаря
    if (t.assignee_id) {
      const u = (await client.query(
        'SELECT id, username, full_name, email, role, is_active, modules FROM users WHERE id = $1', [t.assignee_id])).rows[0];
      if (u) await syncUser(u);
    }

    const title = `#${t.id} ${t.title}`.slice(0, 200);
    const status = taskStatus(t);
    const cat = await categoryId(client);
    const existing = (await client.query(
      `SELECT id, all_day FROM calendar.tasks WHERE id = $1 OR helpdesk_ticket_id = $2
        ORDER BY (id = $1) DESC LIMIT 1`, [t.calendar_task_id || 0, t.id])).rows[0];

    // Время: со сроком — час до срока; без срока — весь день назначения.
    // Задачу без срока, которую уже передвинули в календаре, не трогаем.
    // Закрытую заявку без задачи в календарь не добавляем — показывать нечего
    if (!existing && t.is_closed) { await client.query('COMMIT'); return; }
    const prevAssignee = existing
      ? (await client.query('SELECT user_id FROM calendar.task_assignees WHERE task_id = $1 LIMIT 1', [existing.id])).rows[0]?.user_id ?? null
      : null;
    // День задачи без срока сохраняем, пока не сменился исполнитель (при назначении — переносим на сегодня)
    const keepTime = !t.due_at && existing && existing.all_day && prevAssignee === (t.assignee_id || null);
    const allDay = !t.due_at;
    // Без срока: заявка без исполнителя — на день создания, с исполнителем — на день назначения (сегодня)
    const dayOf = t.assignee_id ? new Date() : t.created_at;
    const START = (a, d, b) => `CASE WHEN ${a}::boolean THEN date_trunc('day', ${b}::timestamptz) ELSE ${d}::timestamptz - interval '1 hour' END`;
    const END = (a, d, b) => `CASE WHEN ${a}::boolean THEN date_trunc('day', ${b}::timestamptz) ELSE ${d}::timestamptz END`;

    let taskId;
    if (existing) {
      taskId = existing.id;
      const vals = [title, description(t), status, t.priority, cat, actorId, taskId];
      let timeSql = '';
      if (!keepTime) {
        vals.push(allDay, t.due_at, dayOf);
        timeSql = `, start_at = ${START('$8', '$9', '$10')}, end_at = ${END('$8', '$9', '$10')}, all_day = $8`;
      }
      await client.query(
        `UPDATE calendar.tasks SET title = $1, description = $2, status = $3::calendar.task_status,
                priority = $4::calendar.task_priority, category_id = $5, updated_by = $6, updated_at = now()${timeSql}
          WHERE id = $7`, vals);
    } else {
      const ins = await client.query(
        `INSERT INTO calendar.tasks (title, description, start_at, end_at, all_day, status, priority, category_id,
                                     created_by, updated_by, helpdesk_ticket_id)
         VALUES ($1, $2, ${START('$3', '$4', '$10')}, ${END('$3', '$4', '$10')}, $3,
                 $5::calendar.task_status, $6::calendar.task_priority, $7, $8, $8, $9)
         RETURNING id`,
        [title, description(t), allDay, t.due_at, status, t.priority, cat, actorId, t.id, dayOf]);
      taskId = ins.rows[0].id;
      await client.query(
        `INSERT INTO calendar.activity_log (user_id, action, entity, entity_id, details)
         VALUES ($1, 'create', 'task', $2, $3)`, [actorId, taskId, JSON.stringify({ title, helpdesk_ticket: t.id })]);
    }
    await client.query('DELETE FROM calendar.task_assignees WHERE task_id = $1', [taskId]);
    if (t.assignee_id) {
      await client.query('INSERT INTO calendar.task_assignees (task_id, user_id) VALUES ($1, $2)', [taskId, t.assignee_id]);
    }
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

/** Перенос: открытые заявки, у которых ещё нет задачи в календаре */
async function backfill() {
  const { rows } = await db().query(
    `SELECT t.id FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id
      WHERE t.calendar_task_id IS NULL AND NOT s.is_closed
        AND NOT EXISTS (SELECT 1 FROM calendar.tasks ct WHERE ct.helpdesk_ticket_id = t.id)`);
  for (const r of rows) await syncTicket(r.id);
  return rows.length;
}

/**
 * Задача календаря → заявка: статус задачи меняет статус заявки.
 * done — первый «закрытый» статус (не «отклонена/отменена»), cancelled — «отклонена/отменена» (если есть),
 * in_progress — первый открытый не начальный статус, todo — начальный. Права — как в заявке: администратор helpdesk
 * или исполнитель этой заявки (свободную заявку исполнитель берёт себе). Возвращает текст для журнала или null.
 */
async function fromTask(taskId, taskStatus, user) {
  const { level } = require('../portal/modules');
  const lv = level(user, 'helpdesk');
  if (!['executor', 'admin'].includes(lv)) return null;
  const c = db();
  const { rows } = await c.query(
    `SELECT t.id, t.status_id, t.assignee_id, s.name AS status_name, s.is_closed
       FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id
      WHERE t.calendar_task_id = $1 OR t.id = (SELECT helpdesk_ticket_id FROM calendar.tasks WHERE id = $1) LIMIT 1`, [taskId]);
  const t = rows[0];
  if (!t) return null;
  if (lv !== 'admin' && t.assignee_id && t.assignee_id !== user.id) return null;
  const { rows: sts } = await c.query('SELECT * FROM helpdesk.statuses ORDER BY sort, id');
  const cancel = (s) => /отклон|отмен|отозван/i.test(s.name);
  const target = {
    done: sts.find((s) => s.is_closed && !cancel(s)) || sts.find((s) => s.is_closed),
    cancelled: sts.find((s) => s.is_closed && cancel(s)),
    in_progress: sts.find((s) => !s.is_closed && !s.is_default) || sts.find((s) => s.is_default),
    todo: sts.find((s) => s.is_default) || sts.find((s) => !s.is_closed),
  }[taskStatus];
  if (!target || target.id === t.status_id) return null;
  // Уже в «той же группе» (например, закрыта другим закрытым статусом) — не трогаем
  if ((taskStatus === 'done' || taskStatus === 'cancelled') && t.is_closed) return null;
  // Открытая заявка: из «новой» в «в работе» — да; остальное (в работе → к выполнению) не трогаем
  const isNew = t.status_id === (sts.find((s) => s.is_default) || {}).id;
  if ((taskStatus === 'todo' || taskStatus === 'in_progress') && !t.is_closed && !(taskStatus === 'in_progress' && isNew)) return null;
  const who = { userId: user.id };
  await L.tx(async (x) => {
    await x.query(`UPDATE helpdesk.tickets SET status_id = $2, updated_at = now(),
                     closed_at = ${target.is_closed ? 'COALESCE(closed_at, now())' : 'NULL'}${!t.assignee_id ? ', assignee_id = $3' : ''}
                   WHERE id = $1`, !t.assignee_id ? [t.id, target.id, user.id] : [t.id, target.id]);
    if (!t.assignee_id) await L.addHistory(x, t.id, who, 'assignee', { from: null, to: user.is_service ? 'Служба ИТ' : (user.full_name || user.username) });
    await L.addHistory(x, t.id, who, 'status', { from: t.status_name, to: target.name, via: 'calendar' });
  });
  require('./notify').statusChanged(t.id).catch(() => {});
  return `Заявка #${t.id}: ${target.name}`;
}

module.exports = { syncTicket, removeTicketTask, backfill, fromTask };
