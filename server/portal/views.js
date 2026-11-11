// Сохранённые фильтры (раздел «Заявки», календарь) и избранное / недавно открытое — у каждого пользователя свои.
const express = require('express');
const { query } = require('../inventory/db');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');

const router = express.Router();
router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' })));

const SECTIONS = ['helpdesk', 'calendar'];
const KINDS = { device: 'Техника', ticket: 'Заявки', task: 'Задачи', document: 'Документы', workplace: 'Рабочие места' };

// ---------- сохранённые фильтры ----------
router.get('/views', ah(async (req, res) => {
  const section = String(req.query.section || '');
  if (!SECTIONS.includes(section)) throw new HttpError(400, 'Неизвестный раздел');
  const { rows } = await query(
    `SELECT v.id, v.name, v.params, v.shared, v.user_id = $2 AS mine,
            CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS owner
       FROM saved_views v JOIN users u ON u.id = v.user_id
      WHERE v.section = $1 AND (v.user_id = $2 OR v.shared)
      ORDER BY (v.user_id = $2) DESC, lower(v.name)`, [section, req.user.id]);
  res.json(rows);
}));

router.post('/views', ah(async (req, res) => {
  const b = req.body || {};
  if (!SECTIONS.includes(b.section)) throw new HttpError(400, 'Неизвестный раздел');
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, 'Введите название фильтра');
  const params = b.params && typeof b.params === 'object' ? b.params : {};
  if (JSON.stringify(params).length > 5000) throw new HttpError(400, 'Слишком большой фильтр');
  const { rows } = await query(
    'INSERT INTO saved_views (user_id, section, name, params, shared) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, b.section, name, JSON.stringify(params), !!b.shared]);
  res.status(201).json({ id: rows[0].id });
}));

router.delete('/views/:id', ah(async (req, res) => {
  const { rowCount } = await query('DELETE FROM saved_views WHERE id = $1 AND user_id = $2', [intOrNull(req.params.id), req.user.id]);
  if (!rowCount) throw new HttpError(404, 'Фильтр не найден (удалить можно только свой)');
  res.json({ ok: true });
}));

// ---------- избранное и недавние ----------
router.get('/items', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT kind, ref, title, link, favorite, viewed_at FROM user_items
      WHERE user_id = $1 AND (favorite OR viewed_at IS NOT NULL) ORDER BY viewed_at DESC NULLS LAST LIMIT 200`, [req.user.id]);
  res.json({
    favorites: rows.filter((r) => r.favorite).sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, 'ru')),
    recent: rows.filter((r) => r.viewed_at).slice(0, 15),
    kinds: KINDS,
  });
}));

function itemBody(b) {
  if (!KINDS[b.kind]) throw new HttpError(400, 'Неизвестный вид');
  const ref = str(String(b.ref ?? ''), 50);
  const link = str(b.link, 300);
  if (!ref || !link || !link.startsWith('/')) throw new HttpError(400, 'Неверная ссылка');
  return { kind: b.kind, ref, title: str(b.title, 200) || `${KINDS[b.kind]} ${ref}`, link };
}

// Открыли объект — в «недавние» (храним последние 50)
router.post('/items/viewed', ah(async (req, res) => {
  const it = itemBody(req.body || {});
  await query(
    `INSERT INTO user_items (user_id, kind, ref, title, link, viewed_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id, kind, ref) DO UPDATE SET title = EXCLUDED.title, link = EXCLUDED.link, viewed_at = now()`,
    [req.user.id, it.kind, it.ref, it.title, it.link]);
  await query(
    `UPDATE user_items SET viewed_at = NULL WHERE user_id = $1 AND viewed_at IS NOT NULL AND (kind, ref) NOT IN
       (SELECT kind, ref FROM user_items WHERE user_id = $1 AND viewed_at IS NOT NULL ORDER BY viewed_at DESC LIMIT 50)`, [req.user.id]);
  await query('DELETE FROM user_items WHERE user_id = $1 AND NOT favorite AND viewed_at IS NULL', [req.user.id]);
  const { rows } = await query('SELECT favorite FROM user_items WHERE user_id = $1 AND kind = $2 AND ref = $3', [req.user.id, it.kind, it.ref]);
  res.json({ favorite: !!(rows[0] && rows[0].favorite) });
}));

// Звёздочка: добавить / убрать из избранного
router.put('/items/favorite', ah(async (req, res) => {
  const it = itemBody(req.body || {});
  const on = !!req.body.on;
  await query(
    `INSERT INTO user_items (user_id, kind, ref, title, link, favorite) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, kind, ref) DO UPDATE SET title = EXCLUDED.title, link = EXCLUDED.link, favorite = EXCLUDED.favorite`,
    [req.user.id, it.kind, it.ref, it.title, it.link, on]);
  await query('DELETE FROM user_items WHERE user_id = $1 AND NOT favorite AND viewed_at IS NULL', [req.user.id]);
  res.json({ favorite: on });
}));

router.get('/items/state', ah(async (req, res) => {
  const { rows } = await query('SELECT favorite FROM user_items WHERE user_id = $1 AND kind = $2 AND ref = $3',
    [req.user.id, String(req.query.kind || ''), String(req.query.ref || '')]);
  res.json({ favorite: !!(rows[0] && rows[0].favorite) });
}));

module.exports = router;
