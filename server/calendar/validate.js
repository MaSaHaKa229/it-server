import { ZodError } from 'zod';

export const validate = (schema, data) => schema.parse(data);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Оборачивает async-обработчики, чтобы ошибки попадали в errorHandler
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Некорректные данные',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Запись с такими данными уже существует' });
  if (err.code === '23514') return res.status(400).json({ error: 'Окончание не может быть раньше начала' });
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
