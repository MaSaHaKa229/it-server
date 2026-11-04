import { Router } from 'express';
import { z } from 'zod';
import { query, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { ah, validate, HttpError } from '../validate.js';

const r = Router();
const schema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

r.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, (SELECT count(*)::int FROM tasks t WHERE t.category_id = c.id) AS task_count
     FROM categories c ORDER BY c.name`
  );
  res.json({ categories: rows });
}));

r.post('/', requireRole('editor'), ah(async (req, res) => {
  const d = validate(schema, req.body);
  const { rows } = await query('INSERT INTO categories (name, color) VALUES ($1,$2) RETURNING *', [d.name, d.color]);
  await logActivity({ query }, req.user.id, 'create', 'category', rows[0].id, d);
  res.status(201).json({ category: rows[0] });
}));

r.patch('/:id', requireRole('editor'), ah(async (req, res) => {
  const d = validate(schema.partial(), req.body);
  const { rows } = await query(
    'UPDATE categories SET name = COALESCE($2,name), color = COALESCE($3,color) WHERE id=$1 RETURNING *',
    [req.params.id, d.name ?? null, d.color ?? null]
  );
  if (!rows[0]) throw new HttpError(404, 'Категория не найдена');
  res.json({ category: rows[0] });
}));

r.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  const { rows } = await query('DELETE FROM categories WHERE id=$1 RETURNING name', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Категория не найдена');
  await logActivity({ query }, req.user.id, 'delete', 'category', Number(req.params.id), rows[0]);
  res.json({ ok: true });
}));

export default r;
