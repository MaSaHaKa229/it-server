// Отсутствия сотрудников (отпуск, больничный, командировка, отгул).
// Видят все, у кого есть доступ к календарю. Добавлять и менять: администратор — любые,
// редактор — только свои. Наблюдатель — только просмотр.
import { Router } from 'express';
import { z } from 'zod';
import { query, logActivity } from '../db.js';
import { ah, validate, HttpError } from '../validate.js';
import { absenceCond } from '../scope.js';

const r = Router();

export const KINDS = ['vacation', 'sick', 'trip', 'dayoff', 'other'];

const SELECT = `
  SELECT a.id, a.user_id, a.kind, to_char(a.start_date, 'YYYY-MM-DD') AS start_date, to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
         a.comment, a.created_at, u.name AS user_name, u.color AS user_color, CASE WHEN cu.is_system THEN 'Служба ИТ' ELSE cu.name END AS created_by_name
    FROM absences a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users cu ON cu.id = a.created_by`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

r.get('/', ah(async (req, res) => {
  const where = [];
  const vals = [];
  const day = (v) => (DAY.test(String(v)) ? String(v) : null);
  // from/to — даты (ГГГГ-ММ-ДД); to — не включительно
  if (req.query.from) { const v = day(req.query.from); if (!v) throw new HttpError(400, 'Неверная дата'); vals.push(v); where.push(`a.end_date >= $${vals.length}::date`); }
  if (req.query.to) { const v = day(req.query.to); if (!v) throw new HttpError(400, 'Неверная дата'); vals.push(v); where.push(`a.start_date < $${vals.length}::date`); }
  if (req.query.user) {
    vals.push(String(req.query.user).split(',').map(Number).filter((n) => n > 0));
    where.push(`a.user_id = ANY($${vals.length}::int[])`);
  }
  if (req.query.kind) { vals.push(String(req.query.kind).split(',')); where.push(`a.kind = ANY($${vals.length}::text[])`); }
  where.push('NOT u.is_system'); // отсутствия служебной учётной записи не показываются
  const scoped = absenceCond(req.user, vals); // уровень «Просмотр»: только разрешённые администратором
  if (scoped) where.push(scoped);
  const { rows } = await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_date, u.name LIMIT 5000`, vals);
  res.json({ absences: rows });
}));

const body = z.object({
  user_id: z.number().int().positive(),
  kind: z.enum(KINDS).default('vacation'),
  start_date: z.string().regex(DAY, 'Укажите дату начала'),
  end_date: z.string().regex(DAY, 'Укажите дату окончания'),
  comment: z.string().max(1000).default(''),
}).refine((d) => d.end_date >= d.start_date, { message: 'Окончание не может быть раньше начала', path: ['end_date'] });

function checkRights(user, userId) {
  if (user.role === 'admin') return;
  if (user.role === 'editor' && userId === user.id) return;
  throw new HttpError(403, user.role === 'editor' ? 'Можно отмечать только свои отсутствия' : 'Недостаточно прав');
}

async function overlap(d, exceptId = 0) {
  const { rows } = await query(
    `SELECT 1 FROM absences WHERE user_id = $1 AND id <> $4 AND start_date <= $3::date AND end_date >= $2::date LIMIT 1`,
    [d.user_id, d.start_date, d.end_date, exceptId]);
  if (rows[0]) throw new HttpError(409, 'У сотрудника уже есть отсутствие в эти даты');
}

async function fetchOne(id) {
  const { rows } = await query(`${SELECT} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Запись не найдена');
  return rows[0];
}

r.post('/', ah(async (req, res) => {
  const d = validate(body, req.body);
  checkRights(req.user, d.user_id);
  const u = await query('SELECT name FROM users WHERE id = $1', [d.user_id]);
  if (!u.rows[0]) throw new HttpError(400, 'Сотрудник не найден');
  await overlap(d);
  const { rows } = await query(
    `INSERT INTO absences (user_id, kind, start_date, end_date, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.user_id, d.kind, d.start_date, d.end_date, d.comment, req.user.id]);
  await logActivity({ query }, req.user.id, 'create', 'absence', rows[0].id, { name: u.rows[0].name, kind: d.kind, from: d.start_date, to: d.end_date });
  res.status(201).json({ absence: await fetchOne(rows[0].id) });
}));

r.patch('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const old = await fetchOne(id);
  checkRights(req.user, old.user_id);
  const d = validate(body, { ...old, ...req.body });
  checkRights(req.user, d.user_id);
  await overlap(d, id);
  await query(`UPDATE absences SET user_id=$2, kind=$3, start_date=$4, end_date=$5, comment=$6, updated_at=now() WHERE id=$1`,
    [id, d.user_id, d.kind, d.start_date, d.end_date, d.comment]);
  const a = await fetchOne(id);
  await logActivity({ query }, req.user.id, 'update', 'absence', id, { name: a.user_name, kind: d.kind, from: d.start_date, to: d.end_date });
  res.json({ absence: a });
}));

r.delete('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const old = await fetchOne(id);
  checkRights(req.user, old.user_id);
  await query('DELETE FROM absences WHERE id = $1', [id]);
  await logActivity({ query }, req.user.id, 'delete', 'absence', id, { name: old.user_name, kind: old.kind, from: old.start_date, to: old.end_date });
  res.json({ ok: true });
}));

export default r;
