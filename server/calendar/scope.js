// Что видит пользователь календаря: ограничения, заданные администратором портала.
//  • «Только свои задачи» (calendar_own_only) — наблюдатели и редакторы: задачи, где он автор или исполнитель.
//  • Уровень «Просмотр» — дополнительно «выбранные задачи»: категории (calendar_cats, 0 — «без категории»)
//    и сотрудники-исполнители (calendar_people, 0 — «без исполнителя»); свои задачи видны всегда.
//    Отсутствия (calendar_absences): 'all' — все, 'none' — не показывать, [id] — только этих сотрудников.

const ids = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : null);

/** Ограничения пользователя (req.user календаря строится в auth.js) */
export function scopeOf(portalUser, role) {
  const m = (portalUser && portalUser.modules) || {};
  const own = role !== 'admin' && !!m.calendar_own_only;
  if (role !== 'viewer') return { own, cats: null, people: null, absences: 'all' };
  const abs = m.calendar_absences === 'none' ? 'none' : Array.isArray(m.calendar_absences) ? ids(m.calendar_absences) : 'all';
  return { own, cats: own ? null : ids(m.calendar_cats), people: own ? null : ids(m.calendar_people), absences: abs };
}

const restricted = (s) => s && (s.own || s.cats || s.people);

/**
 * Условие SQL для задач (псевдоним t) или null, если ограничений нет. vals пополняется параметрами.
 * series = true — то же для шаблонов периодических задач (псевдоним s).
 */
export function taskCond(user, vals, series = false) {
  const s = user.scope;
  if (!restricted(s)) return null;
  const a = series ? 's' : 't';
  vals.push(user.id);
  const me = `$${vals.length}`;
  const mine = series
    ? `(s.created_by = ${me} OR ${me} = ANY(s.assignees))`
    : `(t.created_by = ${me} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${me}))`;
  if (s.own) return mine;
  const and = [];
  if (s.cats) {
    const or = [];
    const list = s.cats.filter((n) => n > 0);
    if (list.length) { vals.push(list); or.push(`${a}.category_id = ANY($${vals.length}::int[])`); }
    if (s.cats.includes(0)) or.push(`${a}.category_id IS NULL`);
    and.push(or.length ? `(${or.join(' OR ')})` : 'FALSE');
  }
  if (s.people) {
    const or = [];
    const list = s.people.filter((n) => n > 0);
    if (list.length) {
      vals.push(list);
      const p = `$${vals.length}::int[]`;
      or.push(series ? `s.assignees && ${p}` : `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ANY(${p}))`);
    }
    if (s.people.includes(0)) or.push(series ? 'cardinality(s.assignees) = 0' : 'NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)');
    and.push(or.length ? `(${or.join(' OR ')})` : 'FALSE');
  }
  return `(${mine} OR (${and.join(' AND ')}))`;
}

/** Условие для отсутствий (псевдоним a) или null */
export function absenceCond(user, vals) {
  const s = user.scope;
  if (!s || s.absences === 'all') return null;
  if (s.absences === 'none') return 'FALSE';
  vals.push([user.id, ...s.absences.filter((n) => n > 0)]);
  return `a.user_id = ANY($${vals.length}::int[])`;
}
