// Уведомления календаря: назначили задачу, новый комментарий (общий механизм портала — server/portal/notify.js)
import { createRequire } from 'node:module';
import { query } from './db.js';

const require = createRequire(import.meta.url);
const N = require('../portal/notify.js');

const link = (id) => `/calendar/#/calendar?task=${id}`;
const when = (t) => (t.all_day
  ? new Date(t.start_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    + (new Date(t.end_at).toDateString() !== new Date(t.start_at).toDateString()
      ? ' — ' + new Date(t.end_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '')
  : new Date(t.start_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }));

/** Назначили задачу: userIds — новые исполнители; more — сколько ещё повторов создано вместе с ней */
export async function taskAssigned(taskId, userIds, actorId, more = 0) {
  if (!userIds || !userIds.length) return;
  try {
    const { rows } = await query('SELECT id, title, start_at, end_at, all_day FROM tasks WHERE id = $1', [taskId]);
    const t = rows[0];
    if (!t) return;
    await N.emit(userIds, 'task_assigned', {
      title: `Вам назначена задача: ${t.title}`,
      body: `Когда: ${when(t)}${more ? ` (и ещё повторов: ${more})` : ''}`,
      link: link(t.id),
    }, actorId);
  } catch (e) {
    console.error('Уведомление о задаче:', e.message);
  }
}

/** Новый комментарий: исполнителям и автору задачи, кроме написавшего */
export async function taskCommented(taskId, actor, body) {
  try {
    const { rows } = await query(
      `SELECT t.title, t.created_by, COALESCE(array_agg(a.user_id) FILTER (WHERE a.user_id IS NOT NULL), '{}') AS assignees
         FROM tasks t LEFT JOIN task_assignees a ON a.task_id = t.id WHERE t.id = $1 GROUP BY t.id`, [taskId]);
    const t = rows[0];
    if (!t) return;
    await N.emit([...t.assignees, t.created_by], 'task_comment', {
      title: `Комментарий к задаче: ${t.title}`,
      body: `${actor.is_system ? 'Служба ИТ' : actor.name}: ${String(body).slice(0, 1000)}`,
      link: link(taskId),
    }, actor.id);
  } catch (e) {
    console.error('Уведомление о комментарии:', e.message);
  }
}
