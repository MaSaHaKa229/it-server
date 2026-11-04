// Состояния техники хранятся в таблице device_statuses и редактируются в настройках
const { HttpError } = require('./util');

async function loadStatuses(db) {
  const { rows } = await db.query('SELECT key, label, color, sort FROM device_statuses ORDER BY sort, label');
  return rows;
}

/** Проверить ключ состояния; если не передан — вернуть первое по порядку (состояние по умолчанию) */
async function resolveStatus(db, key) {
  const list = await loadStatuses(db);
  if (!list.length) throw new HttpError(500, 'Не настроено ни одного состояния техники');
  if (key == null || key === '') return list[0].key;
  if (!list.some((s) => s.key === key)) throw new HttpError(400, 'Недопустимое состояние');
  return key;
}

const labelMap = (list) => Object.fromEntries(list.map((s) => [s.key, s.label]));

module.exports = { loadStatuses, resolveStatus, labelMap };
