// Автоназначение исполнителя новой заявки (helpdesk.assign_rules).
// Правила проверяются по порядку; подходит правило, у которого совпали вид проблемы и отдел заявителя
// (пустое условие — «любой»). Отсутствующие сегодня (отпуск, больничный… в календаре) не назначаются.
// Если ни одно правило не сработало — исполнитель по умолчанию из вида проблемы (как раньше).

/** Исполнители helpdesk (без служебной учётной записи) */
async function executors(db) {
  const { rows } = await db.query(
    `SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name FROM public.users
      WHERE is_active AND role <> 'superadmin' AND modules->>'helpdesk' IN ('executor', 'admin')`);
  return rows;
}

async function absentToday(db) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT user_id FROM calendar.absences WHERE current_date BETWEEN start_date AND end_date`);
    return new Set(rows.map((r) => r.user_id));
  } catch {
    return new Set(); // календаря нет — не учитываем
  }
}

/** Открытые заявки по исполнителям */
async function load(db, ids) {
  const { rows } = await db.query(
    `SELECT t.assignee_id, count(*)::int AS n FROM tickets t JOIN statuses s ON s.id = t.status_id
      WHERE NOT s.is_closed AND t.assignee_id = ANY($1::int[]) GROUP BY t.assignee_id`, [ids]);
  return new Map(rows.map((r) => [r.assignee_id, r.n]));
}

/**
 * Подобрать исполнителя. Возвращает { assigneeId, name, how } или null.
 * category — строка вида проблемы (или null), departmentId — отдел заявителя из справочника.
 */
async function pick(db, { category, departmentId }) {
  const execs = await executors(db);
  const byId = new Map(execs.map((e) => [e.id, e]));
  const absent = await absentToday(db);
  const available = (id) => byId.has(id) && !absent.has(id);
  const { rows: rules } = await db.query(
    `SELECT r.*, c.name AS category_name, l.value AS department_name FROM assign_rules r
       LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN public.lookups l ON l.id = r.department_id
      WHERE r.is_active ORDER BY r.sort, r.id`);
  for (const r of rules) {
    if (r.category_id && (!category || r.category_id !== category.id)) continue;
    if (r.department_id && r.department_id !== departmentId) continue;
    const cond = [r.category_name, r.department_name].filter(Boolean).join(', ') || 'любая заявка';
    if (r.mode === 'user') {
      if (available(r.assignee_id)) return { assigneeId: r.assignee_id, name: byId.get(r.assignee_id).name, how: `правило: ${cond}` };
      continue;
    }
    const pool = (r.pool && r.pool.length ? r.pool : execs.map((e) => e.id)).filter(available);
    if (!pool.length) continue;
    const n = await load(db, pool);
    pool.sort((a, b) => (n.get(a) || 0) - (n.get(b) || 0) || byId.get(a).name.localeCompare(byId.get(b).name, 'ru'));
    return { assigneeId: pool[0], name: byId.get(pool[0]).name, how: `правило: ${cond}, наименее загруженный` };
  }
  if (category && category.default_assignee_id && byId.has(category.default_assignee_id)) {
    return { assigneeId: category.default_assignee_id, name: byId.get(category.default_assignee_id).name, how: 'исполнитель вида проблемы' };
  }
  return null;
}

module.exports = { pick };
