const STATUSES = ['active', 'inactive', 'draft'];
const ROLES = ['superadmin', 'editor', 'reader'];
const EDITORS = ['superadmin', 'editor'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

// Обёртка для async-обработчиков Express 4
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Некорректный идентификатор');
  return id;
}

module.exports = { STATUSES, ROLES, EDITORS, httpError, ah, parseId };
