class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Обёртка для async-обработчиков Express */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const str = (v, max = 2000) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Ожидалось целое число');
  return n;
};

const parseJSON = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

module.exports = { HttpError, ah, str, intOrNull, parseJSON };
