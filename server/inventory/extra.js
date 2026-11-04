// Общие функции для значений дополнительных полей (техника и ПО)
const { HttpError } = require('./util');

/** Нормализовать значения доп. полей. Пустое значение → null (поле очищается). Неизвестные поля отбрасываются */
function normalizeExtra(input, defs) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const byId = Object.fromEntries(defs.map((d) => [String(d.id), d]));
  for (const [k, v] of Object.entries(input)) {
    const def = byId[k];
    if (!def) continue;
    if (v === null || v === undefined || String(v).trim() === '') { out[k] = null; continue; }
    let val = String(v).trim().slice(0, 20000);
    if (def.field_type === 'number' && Number.isNaN(Number(val.replace(',', '.')))) {
      throw new HttpError(400, `Поле «${def.label}» должно быть числом`);
    }
    if (def.field_type === 'bool') val = ['true', '1', 'да', 'yes'].includes(val.toLowerCase()) ? 'true' : 'false';
    out[k] = val;
  }
  return out;
}

/** Полный набор значений (для замены целиком): без пустых */
function compactExtra(input, defs) {
  const out = normalizeExtra(input, defs);
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

/** Доп. поля ПО: target = 'software' | 'install' | undefined (все) */
async function loadSoftwareDefs(db, target) {
  const { rows } = await db.query(
    `SELECT id, label, field_type, options, lookup_kind, target, sort
       FROM software_field_defs ${target ? 'WHERE target = $1' : ''} ORDER BY sort, id`,
    target ? [target] : []);
  return rows;
}

module.exports = { normalizeExtra, compactExtra, loadSoftwareDefs };
