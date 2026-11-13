// Склад расходников и запчастей: позиции (картриджи, барабаны, запчасти…), приход, выдача на принтер, списание.
// Остаток — сумма движений. Позиция связывается с принтерами по моделям («Для моделей») и по коду
// (код картриджа встречается в названии расходника, которое принтер сообщает по SNMP, — например CF259A).
// Смотреть могут все с доступом к инвентарю, менять — редакторы.
const express = require('express');
const { query, tx } = require('../db');
const { requireStaff } = require('../access');
const { HttpError, ah, str, intOrNull } = require('../util');
const { sendXlsx } = require('../../portal/xlsx');

const router = express.Router();
const CATS = { cartridge: 'Картридж / тонер', drum: 'Фотобарабан', ink: 'Чернила', part: 'Запчасть', other: 'Другое' };
const KINDS = { in: 'Приход', out: 'Выдача', writeoff: 'Списание', adjust: 'Корректировка' };

const ITEMS_SQL = `
  SELECT i.*, COALESCE(m.qty, 0)::int AS qty, m.last_at,
         (i.min_qty > 0 AND COALESCE(m.qty, 0) < i.min_qty) AS low
    FROM stock_items i
    LEFT JOIN (SELECT item_id, sum(qty) AS qty, max(created_at) AS last_at FROM stock_moves GROUP BY item_id) m ON m.item_id = i.id`;

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const tokens = (s) => String(s || '').split(/[,;\n]+/).map(norm).filter((x) => x.length >= 2);

/** Подходит ли позиция к принтеру: модель из карточки/SNMP и названия расходников, которые он сообщает */
function matches(item, { model, snmpModel, supplyNames }) {
  const models = [norm(model), norm(snmpModel)].filter(Boolean);
  const code = norm(item.code);
  if (code && code.length >= 3 && (supplyNames || []).some((n) => norm(n).includes(code))) return true;
  return tokens(item.models).some((t) => models.some((m) => m.includes(t) || t.includes(m)));
}

/** Позиции склада для расходника принтера (уведомления «заканчивается тонер»): [{ name, qty, unit }] */
async function forSupply(device, supplyName) {
  const { rows } = await query(`${ITEMS_SQL} WHERE NOT i.archived`);
  const code = (it) => norm(it.code);
  const exact = rows.filter((it) => code(it).length >= 3 && norm(supplyName).includes(code(it)));
  return (exact.length ? exact : rows.filter((it) => matches(it, { ...device, supplyNames: [supplyName] })))
    .map((it) => ({ id: it.id, name: it.name, qty: it.qty, unit: it.unit }));
}

/** Позиции, у которых остаток ниже минимального (уведомление «мало на складе») */
async function lowItems() {
  const { rows } = await query(`${ITEMS_SQL} WHERE NOT i.archived AND i.min_qty > 0 AND COALESCE(m.qty, 0) < i.min_qty ORDER BY i.name`);
  return rows;
}

function itemBody(b) {
  const name = str(b.name, 300);
  if (!name) throw new HttpError(400, 'Укажите название');
  return [name, str(b.code, 100) || '', CATS[b.category] ? b.category : 'other', str(b.models, 2000) || '',
    str(b.unit, 20) || 'шт.', Math.max(0, Math.min(100000, Number(b.min_qty) || 0)), str(b.note, 2000) || '', !!b.archived];
}

// ---------- позиции ----------
router.get('/', ah(async (req, res) => {
  const { rows } = await query(`${ITEMS_SQL} ORDER BY i.archived, i.category, i.name`);
  res.json({ items: rows, categories: CATS, kinds: KINDS });
}));

router.post('/', requireStaff, ah(async (req, res) => {
  const v = itemBody(req.body || {});
  const qty0 = Math.max(0, Math.round(Number((req.body || {}).qty) || 0));
  const out = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO stock_items (name, code, category, models, unit, min_qty, note, archived) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, v);
    if (qty0) {
      await db.query(`INSERT INTO stock_moves (item_id, qty, kind, comment, user_id) VALUES ($1, $2, 'in', 'Начальный остаток', $3)`,
        [rows[0].id, qty0, req.user.id]);
    }
    return rows[0];
  });
  res.status(201).json(out);
}));

router.put('/:id', requireStaff, ah(async (req, res) => {
  const v = itemBody(req.body || {});
  const { rows } = await query(
    `UPDATE stock_items SET name=$1, code=$2, category=$3, models=$4, unit=$5, min_qty=$6, note=$7, archived=$8 WHERE id=$9 RETURNING *`,
    [...v, intOrNull(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Позиция не найдена');
  res.json(rows[0]);
}));

router.delete('/:id', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const { rows } = await query('SELECT count(*)::int AS n FROM stock_moves WHERE item_id = $1', [id]);
  if (rows[0].n > 1) throw new HttpError(400, 'По позиции уже были движения — её можно только убрать в архив');
  await query('DELETE FROM stock_items WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------- движения ----------
const MOVES_SQL = `
  SELECT m.id, m.item_id, m.qty, m.kind, m.comment, m.created_at, m.device_id,
         i.name AS item_name, i.unit,
         CASE WHEN u.is_service THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS user_name,
         t.code AS type_code, t.color AS type_color, t.name AS type_name, d.hostname, lm.value AS model, ll.value AS location
    FROM stock_moves m JOIN stock_items i ON i.id = m.item_id
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN devices d ON d.id = m.device_id LEFT JOIN device_types t ON t.id = d.type_id
    LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN lookups ll ON ll.id = d.location_id`;

router.get('/moves', ah(async (req, res) => {
  const vals = [];
  const w = [];
  if (intOrNull(req.query.item)) { vals.push(intOrNull(req.query.item)); w.push(`m.item_id = $${vals.length}`); }
  if (intOrNull(req.query.device)) { vals.push(intOrNull(req.query.device)); w.push(`m.device_id = $${vals.length}`); }
  const { rows } = await query(`${MOVES_SQL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT 1000`, vals);
  res.json(rows);
}));

router.post('/:id/move', requireStaff, ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const kind = KINDS[b.kind] ? b.kind : null;
  if (!kind) throw new HttpError(400, 'Неизвестное действие');
  const n = Math.round(Number(b.qty));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100000) throw new HttpError(400, 'Укажите количество');
  const qty = kind === 'in' ? Math.abs(n) : kind === 'adjust' ? n : -Math.abs(n);
  const deviceId = kind === 'out' ? intOrNull(b.device_id) : null;
  const out = await tx(async (db) => {
    const { rows: [it] } = await db.query('SELECT * FROM stock_items WHERE id = $1 FOR UPDATE', [id]);
    if (!it) throw new HttpError(404, 'Позиция не найдена');
    const { rows: [s] } = await db.query('SELECT COALESCE(sum(qty), 0)::int AS qty FROM stock_moves WHERE item_id = $1', [id]);
    if (s.qty + qty < 0) throw new HttpError(400, `На складе только ${s.qty} ${it.unit}`);
    if (deviceId) {
      const d = await db.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]);
      if (!d.rows[0]) throw new HttpError(400, 'Техника не найдена');
    }
    const { rows } = await db.query(
      `INSERT INTO stock_moves (item_id, qty, kind, device_id, comment, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, qty, kind, deviceId, str(b.comment, 1000) || '', req.user.id]);
    if (deviceId) {
      await db.query('INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, $3, $4)',
        [deviceId, req.user.id, 'stock_issued', JSON.stringify({ 'Со склада': [null, `${it.name} — ${Math.abs(qty)} ${it.unit}`] })]);
    }
    return { ...rows[0], left: s.qty + qty };
  });
  res.status(201).json(out);
}));

// Отменить движение (ошибочный ввод) — только последнее по позиции и не старше суток
router.delete('/moves/:mid', requireStaff, ah(async (req, res) => {
  const mid = intOrNull(req.params.mid);
  await tx(async (db) => {
    const { rows: [m] } = await db.query('SELECT * FROM stock_moves WHERE id = $1', [mid]);
    if (!m) throw new HttpError(404, 'Запись не найдена');
    const { rows: [last] } = await db.query('SELECT id FROM stock_moves WHERE item_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [m.item_id]);
    if (last.id !== m.id || Date.now() - new Date(m.created_at).getTime() > 864e5) {
      throw new HttpError(400, 'Отменить можно только последнюю запись по позиции и в течение суток. Иначе — «Корректировка».');
    }
    const { rows: [s] } = await db.query('SELECT COALESCE(sum(qty), 0)::int AS qty FROM stock_moves WHERE item_id = $1', [m.item_id]);
    if (s.qty - m.qty < 0) throw new HttpError(400, 'После отмены остаток стал бы меньше нуля');
    await db.query('DELETE FROM stock_moves WHERE id = $1', [mid]);
  });
  res.json({ ok: true });
}));

// ---------- для карточки принтера ----------
router.get('/for-device/:id', ah(async (req, res) => {
  const id = intOrNull(req.params.id);
  const { rows: [d] } = await query(
    `SELECT d.id, lm.value AS model, ps.model AS snmp_model, ps.supplies
       FROM devices d LEFT JOIN lookups lm ON lm.id = d.model_id LEFT JOIN printer_supplies ps ON ps.device_id = d.id
      WHERE d.id = $1`, [id]);
  if (!d) throw new HttpError(404, 'Техника не найдена');
  const dev = { model: d.model, snmpModel: d.snmp_model, supplyNames: (d.supplies || []).map((x) => x.name) };
  const { rows } = await query(`${ITEMS_SQL} WHERE NOT i.archived ORDER BY i.name`);
  const items = rows.filter((it) => matches(it, dev));
  const { rows: issued } = await query(`${MOVES_SQL} WHERE m.device_id = $1 ORDER BY m.created_at DESC LIMIT 20`, [id]);
  res.json({ items, issued });
}));

// ---------- Excel ----------
router.get('/export.xlsx', ah(async (req, res) => {
  const { rows } = await query(`${ITEMS_SQL} WHERE NOT i.archived ORDER BY i.category, i.name`);
  await sendXlsx(res, 'sklad.xlsx', 'Склад', [
    { header: 'Позиция', key: 'name', width: 40 },
    { header: 'Код', key: 'code', width: 14 },
    { header: 'Вид', key: 'category', width: 18, get: (r) => CATS[r.category] || r.category },
    { header: 'Для моделей', key: 'models', width: 40 },
    { header: 'Остаток', key: 'qty', width: 10 },
    { header: 'Ед.', key: 'unit', width: 8 },
    { header: 'Минимум', key: 'min_qty', width: 10 },
    { header: 'Мало', key: 'low', width: 8, get: (r) => (r.low ? 'да' : '') },
    { header: 'Последнее движение', key: 'last_at', width: 18, date: true },
    { header: 'Примечание', key: 'note', width: 30 },
  ], rows);
}));

router.get('/moves/export.xlsx', ah(async (req, res) => {
  const { rows } = await query(`${MOVES_SQL} ORDER BY m.created_at DESC LIMIT 20000`);
  await sendXlsx(res, 'sklad-dvizhenie.xlsx', 'Движение', [
    { header: 'Дата', key: 'created_at', width: 18, date: true },
    { header: 'Позиция', key: 'item_name', width: 40 },
    { header: 'Действие', key: 'kind', width: 14, get: (r) => KINDS[r.kind] || r.kind },
    { header: 'Количество', key: 'qty', width: 12 },
    { header: 'Техника', key: 'device', width: 30, get: (r) => (r.device_id ? `${r.type_code}-${r.device_id} ${r.hostname || r.model || ''}` : '') },
    { header: 'Расположение', key: 'location', width: 20 },
    { header: 'Комментарий', key: 'comment', width: 30 },
    { header: 'Кто', key: 'user_name', width: 22 },
  ], rows);
}));

module.exports = router;
module.exports.forSupply = forSupply;
module.exports.lowItems = lowItems;
module.exports.CATS = CATS;
