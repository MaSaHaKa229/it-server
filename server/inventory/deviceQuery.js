// Построение SQL-запросов к списку техники с учётом прав, поиска, фильтров и сортировки
const { CORE_FIELDS, canSeeField } = require('./access');

const LOOKUP_FIELDS = CORE_FIELDS.filter((f) => f.kind === 'lookup');
const TEXT_FIELDS = CORE_FIELDS.filter((f) => f.kind !== 'lookup');

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);
const toIds = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n >= 0);

/**
 * Какие ключи extra видит пользователь.
 * defs — все доп. поля со scope all/type.
 * Возвращает { restricted, visibleIds:Set<string>, globalIds:Set<string>, instance:boolean }
 */
function extraVisibility(P, defs) {
  const globalIds = new Set(defs.map((d) => String(d.id)));
  if (P.fields === null) return { restricted: false, visibleIds: globalIds, globalIds, instance: true };
  const visibleIds = new Set(defs.filter((d) => canSeeField(P, 'f_' + d.id)).map((d) => String(d.id)));
  return { restricted: true, visibleIds, globalIds, instance: canSeeField(P, 'instance_fields') };
}

/**
 * @param {object} o
 *   P        — эффективные права
 *   defs     — доп. поля (scope all/type)
 *   q        — строка поиска
 *   filters  — { type:[], status:[], model:[], ..., software:[], text:{key:value} }
 *   sort,dir — сортировка
 *   limit, offset
 *   id       — выбрать одно устройство
 */
function buildDeviceQuery(o) {
  const { P, defs = [] } = o;
  const params = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  const vis = extraVisibility(P, defs);

  // ---------- SELECT ----------
  const lookupJoins = LOOKUP_FIELDS
    .map((f) => `LEFT JOIN lookups l_${f.key} ON l_${f.key}.id = d.${f.col}`)
    .join('\n    ');

  const softwareExpr = `(SELECT string_agg(s.name || COALESCE(' ' || NULLIF(ds.version, ''), ''), ', ' ORDER BY s.name)
        FROM device_software ds JOIN software s ON s.id = ds.software_id WHERE ds.device_id = d.id)`;

  const select = [
    'd.id', 'd.type_id', 't.name AS type_name', 't.code AS type_code', 't.color AS type_color', 'd.status',
    'st.label AS status_label', 'st.color AS status_color',
    ...TEXT_FIELDS.map((f) => `d.${f.key}`),
    ...LOOKUP_FIELDS.flatMap((f) => [`d.${f.col}`, `l_${f.key}.value AS ${f.key}`]),
    'd.extra', 'd.created_at', 'd.updated_at',
    'd.workplace_id', 'wp.name AS workplace',
  ];
  if (P.software) select.push(`${softwareExpr} AS software`);

  // ---------- WHERE ----------
  const where = [];

  // Ограничения доступа читателя
  if (P.types !== null) where.push(`d.type_id = ANY(${p(P.types)}::int[])`);
  if (P.departments !== null) where.push(`d.department_id = ANY(${p(P.departments)}::int[])`);

  if (o.id != null) where.push(`d.id = ${p(Number(o.id))}`);
  // Техника одного рабочего места
  if (o.workplaceId != null) where.push(`d.workplace_id = ${p(Number(o.workplaceId))}`);

  // Полнотекстовый (по подстроке) поиск по всем видимым полям
  const q = (o.q || '').trim();
  if (q) {
    const parts = [
      `t.code || '-' || d.id`,
      't.name',
      'st.label',
      'wp.name',
    ];
    for (const f of TEXT_FIELDS) if (canSeeField(P, f.key)) parts.push(`d.${f.key}`);
    for (const f of LOOKUP_FIELDS) if (canSeeField(P, f.key)) parts.push(`l_${f.key}.value`);
    if (!vis.restricted) {
      parts.push(`(SELECT string_agg(e.value, ' ') FROM jsonb_each_text(d.extra) e)`);
    } else {
      const keys = p([...vis.visibleIds]);
      const inst = vis.instance
        ? ` OR e.key IN (SELECT fd.id::text FROM field_defs fd WHERE fd.scope = 'device' AND fd.device_id = d.id)`
        : '';
      parts.push(`(SELECT string_agg(e.value, ' ') FROM jsonb_each_text(d.extra) e WHERE e.key = ANY(${keys}::text[])${inst})`);
    }
    if (P.software) {
      parts.push(`(SELECT string_agg(concat_ws(' ', s.name, s.vendor, ds.version,
          (SELECT string_agg(e.value, ' ') FROM jsonb_each_text(s.extra) e),
          (SELECT string_agg(e.value, ' ') FROM jsonb_each_text(ds.extra) e)), ' ')
        FROM device_software ds JOIN software s ON s.id = ds.software_id WHERE ds.device_id = d.id)`);
    }
    const hay = `concat_ws(' ', ${parts.join(', ')})`;
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 10);
    for (const tok of tokens) where.push(`${hay} ILIKE ${p('%' + likeEscape(tok) + '%')}`);
  }

  // Фильтры (выборки)
  const F = o.filters || {};
  if (F.type && toIds(F.type).length) where.push(`d.type_id = ANY(${p(toIds(F.type))}::int[])`);
  if (Array.isArray(F.status)) {
    const st = F.status.map(String).filter(Boolean).slice(0, 100);
    if (st.length) where.push(`d.status = ANY(${p(st)}::text[])`);
  }
  for (const f of LOOKUP_FIELDS) {
    if (!F[f.key] || !canSeeField(P, f.key)) continue;
    const ids = toIds(F[f.key]);
    if (!ids.length) continue;
    const real = ids.filter((i) => i > 0);
    const conds = [];
    if (real.length) conds.push(`d.${f.col} = ANY(${p(real)}::int[])`);
    if (ids.includes(0)) conds.push(`d.${f.col} IS NULL`);
    where.push(`(${conds.join(' OR ')})`);
  }
  if (F.workplace && toIds(F.workplace).length) {
    const ids = toIds(F.workplace);
    const real = ids.filter((i) => i > 0);
    const conds = [];
    if (real.length) conds.push(`d.workplace_id = ANY(${p(real)}::int[])`);
    if (ids.includes(0)) conds.push('d.workplace_id IS NULL');
    where.push(`(${conds.join(' OR ')})`);
  }
  if (P.software && F.software && toIds(F.software).length) {
    where.push(`EXISTS (SELECT 1 FROM device_software ds WHERE ds.device_id = d.id
                 AND ds.software_id = ANY(${p(toIds(F.software))}::int[]))`);
  }
  if (F.text && typeof F.text === 'object') {
    for (const [key, val] of Object.entries(F.text)) {
      if (val == null || String(val).trim() === '') continue;
      const like = p('%' + likeEscape(String(val).trim()) + '%');
      if (TEXT_FIELDS.some((f) => f.key === key) && canSeeField(P, key)) {
        where.push(`d.${key} ILIKE ${like}`);
      } else if (/^f_\d+$/.test(key)) {
        const id = key.slice(2);
        if (!vis.restricted || vis.visibleIds.has(id)) where.push(`d.extra->>${p(id)} ILIKE ${like}`);
      }
    }
  }

  const countParams = params.slice();

  // ---------- ORDER BY ----------
  const sortMap = {
    key: 'd.id', type: 't.name', status: 'st.sort',
    created_at: 'd.created_at', updated_at: 'd.updated_at', workplace: 'wp.name',
  };
  for (const f of TEXT_FIELDS) if (canSeeField(P, f.key)) sortMap[f.key] = `d.${f.key}`;
  for (const f of LOOKUP_FIELDS) if (canSeeField(P, f.key)) sortMap[f.key] = `l_${f.key}.value`;
  if (P.software) sortMap.software = 'software';
  let orderExpr = sortMap[o.sort];
  if (!orderExpr && /^f_\d+$/.test(o.sort || '')) {
    const id = o.sort.slice(2);
    if (!vis.restricted || vis.visibleIds.has(id)) orderExpr = `d.extra->>${p(id)}`;
  }
  if (!orderExpr) orderExpr = 'd.id';
  const dir = String(o.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const order = `ORDER BY ${orderExpr} ${dir} NULLS LAST, d.id DESC`;

  const from = `FROM devices d
    JOIN device_types t ON t.id = d.type_id
    LEFT JOIN device_statuses st ON st.key = d.status
    LEFT JOIN workplaces wp ON wp.id = d.workplace_id
    ${lookupJoins}`;
  const whereSql = where.length ? 'WHERE ' + where.join('\n  AND ') : '';

  const countSql = `SELECT count(*)::int AS total ${from} ${whereSql}`;

  let limitSql = '';
  if (o.limit != null) limitSql += ` LIMIT ${p(Math.max(1, Math.min(Number(o.limit) || 50, 100000)))}`;
  if (o.offset) limitSql += ` OFFSET ${p(Math.max(0, Number(o.offset) || 0))}`;

  const sql = `SELECT ${select.join(', ')}\n  ${from}\n  ${whereSql}\n  ${order}${limitSql}`;
  return { sql, params, countSql, countParams, vis };
}

/** Убрать из строки результата всё, что пользователю не положено видеть */
function sanitizeRow(row, P, vis) {
  if (P.fields !== null) {
    for (const f of CORE_FIELDS) {
      if (canSeeField(P, f.key)) continue;
      delete row[f.key];
      if (f.col) delete row[f.col];
    }
  }
  if (vis.restricted && row.extra) {
    const out = {};
    for (const [k, v] of Object.entries(row.extra)) {
      if (vis.visibleIds.has(k) || (vis.instance && !vis.globalIds.has(k))) out[k] = v;
    }
    row.extra = out;
  }
  return row;
}

/** Доп. поля со scope all/type (используются как колонки списка) */
async function loadGlobalDefs(db) {
  const { rows } = await db.query(
    `SELECT id, label, field_type, options, lookup_kind, scope, type_id, sort
       FROM field_defs WHERE scope IN ('all','type') ORDER BY sort, id`
  );
  return rows;
}

module.exports = { buildDeviceQuery, sanitizeRow, loadGlobalDefs, extraVisibility, LOOKUP_FIELDS, TEXT_FIELDS };
