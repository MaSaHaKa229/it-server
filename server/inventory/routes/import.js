// Импорт техники из Excel / CSV
//   POST /parse     — прочитать файл, вернуть листы и строки
//   GET  /mappings  — запомненные соответствия колонок
//   POST /preview   — разобрать строки по выбранным соответствиям и найти совпадения с базой
//   POST /commit    — записать: новые устройства / объединение с существующими / пропуск
const express = require('express');
const { query, tx } = require('../db');
const { CORE_FIELDS } = require('../access');
const { LOOKUP_FIELDS, TEXT_FIELDS } = require('../deviceQuery');
const { loadStatuses } = require('../statuses');
const { readSpreadsheet } = require('../sheet-read');
const { HttpError, ah } = require('../util');

const router = express.Router();

const MATCHABLE_CORE = ['hostname', 'inv_number', 'serial_number', 'ip_address', 'mac_address'];
const MAX_IMPORT_ROWS = 20000;

const normHeader = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
const lc = (s) => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Нормализация значения для поиска совпадений */
function matchKey(field, v) {
  const s = lc(v);
  if (!s) return '';
  if (field === 'mac_address') { const hex = s.replace(/[^0-9a-f]/g, ''); return hex.length === 12 ? hex : s; }
  // Сетевое имя без домена: PC01.corp.local = PC01
  if (field === 'hostname' && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.')[0];
  return s;
}

// ---------------- контекст: справочники, типы, поля ----------------
async function loadContext(db) {
  const [types, statuses, lookups, defs] = await Promise.all([
    db.query('SELECT id, name, code FROM device_types ORDER BY sort, id'),
    loadStatuses(db),
    db.query('SELECT id, kind, value FROM lookups'),
    db.query(`SELECT id, label, field_type, options, lookup_kind, scope, type_id
                FROM field_defs WHERE scope IN ('all','type') ORDER BY sort, id`),
  ]);
  const typeIdx = new Map();
  for (const t of types.rows) { typeIdx.set(lc(t.name), t); typeIdx.set(lc(t.code), t); }
  const statusIdx = new Map();
  for (const s of statuses) { statusIdx.set(lc(s.label), s); statusIdx.set(lc(s.key), s); }
  const lk = new Map(); // kind → Map(lc(value) → {id, value})
  for (const r of lookups.rows) {
    if (!lk.has(r.kind)) lk.set(r.kind, new Map());
    lk.get(r.kind).set(lc(r.value), r);
  }
  return {
    types: types.rows, typeIdx, statuses, statusIdx, lk,
    defs: defs.rows, defById: new Map(defs.rows.map((d) => [String(d.id), d])),
  };
}

/** Каталог полей, в которые можно загрузить колонку */
function targetCatalog(ctx) {
  return [
    { key: 'type', label: 'Тип техники' },
    { key: 'status', label: 'Состояние' },
    ...CORE_FIELDS.map((f) => ({ key: f.key, label: f.label, matchable: MATCHABLE_CORE.includes(f.key) })),
    ...ctx.defs.map((d) => ({
      key: 'f_' + d.id, label: d.label + ' (доп. поле)',
      matchable: ['text', 'number'].includes(d.field_type),
    })),
  ];
}

// ---------------- разбор значений ----------------
function parseDate(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    const d = new Date(Date.UTC(+y, +m[2] - 1, +m[1]));
    if (d.getUTCDate() === +m[1]) return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}
const BOOL_TRUE = ['да', 'yes', 'true', '1', '+', 'есть', 'y'];
const BOOL_FALSE = ['нет', 'no', 'false', '0', '-', 'n'];

/** Значение доп. поля → { ok, value, warn } */
function customValue(def, raw, ctx) {
  const v = String(raw).trim();
  switch (def.field_type) {
    case 'number': {
      const n = v.replace(/\s/g, '').replace(',', '.');
      return Number.isNaN(Number(n)) ? { warn: `«${def.label}»: «${v}» не число — пропущено` } : { value: n };
    }
    case 'date': {
      const d = parseDate(v);
      return d ? { value: d } : { warn: `«${def.label}»: «${v}» не похоже на дату — пропущено` };
    }
    case 'bool': {
      const s = lc(v);
      if (BOOL_TRUE.includes(s)) return { value: 'true' };
      if (BOOL_FALSE.includes(s)) return { value: 'false' };
      return { warn: `«${def.label}»: «${v}» — ожидалось да/нет, пропущено` };
    }
    case 'select': {
      const opt = (def.options || []).find((o) => lc(o) === lc(v));
      return opt ? { value: opt } : { warn: `«${def.label}»: варианта «${v}» нет в списке — пропущено` };
    }
    case 'lookup': {
      const ex = ctx.lk.get(def.lookup_kind)?.get(lc(v));
      return { value: ex ? ex.value : v, newLookup: ex ? null : { kind: def.lookup_kind, value: v } };
    }
    default:
      return { value: v.slice(0, 20000) };
  }
}

/**
 * Разобрать строку файла.
 * columns — массив ключей полей по индексу колонки ('' / 'skip' — не загружать)
 */
function resolveRow(cells, columns, ctx, defaults) {
  const r = { errors: [], warnings: [], text: {}, lookups: {}, extra: {}, newLookups: [], status: null, type: null, typeFromFile: null };
  const get = (key) => {
    const i = columns.indexOf(key);
    return i >= 0 ? String(cells[i] ?? '').trim() : '';
  };

  // Тип
  const tv = get('type');
  if (tv) {
    const t = ctx.typeIdx.get(lc(tv));
    if (t) { r.type = t; r.typeFromFile = t; } else r.errors.push(`Неизвестный тип техники «${tv}»`);
  }
  if (!r.type && !tv) {
    r.type = ctx.types.find((t) => t.id === Number(defaults.type_id)) || null;
    if (!r.type) r.errors.push('Не указан тип техники');
  }

  // Состояние
  const sv = get('status');
  if (sv) {
    const s = ctx.statusIdx.get(lc(sv));
    if (s) r.status = s.key;
    else r.warnings.push(`Состояние «${sv}» не найдено — будет «${defaultStatusLabel(ctx, defaults)}»`);
  }

  // Базовые поля
  for (const f of TEXT_FIELDS) {
    const v = get(f.key);
    if (v) r.text[f.key] = v.slice(0, f.kind === 'textarea' ? 20000 : 500);
  }
  for (const f of LOOKUP_FIELDS) {
    const v = get(f.key);
    if (!v) continue;
    const ex = ctx.lk.get(f.lookup)?.get(lc(v));
    r.lookups[f.key] = ex ? { id: ex.id, value: ex.value } : { id: null, value: v.slice(0, 300) };
    if (!ex) r.newLookups.push({ kind: f.lookup, value: v.slice(0, 300) });
  }

  // Доп. поля (только применимые к типу)
  columns.forEach((key, i) => {
    if (!/^f_\d+$/.test(key || '')) return;
    const def = ctx.defById.get(key.slice(2));
    const v = String(cells[i] ?? '').trim();
    if (!def || !v) return;
    if (def.scope === 'type' && r.type && def.type_id !== r.type.id) {
      r.warnings.push(`Поле «${def.label}» не используется для типа «${r.type.name}» — пропущено`);
      return;
    }
    const res = customValue(def, v, ctx);
    if (res.warn) r.warnings.push(res.warn);
    else {
      r.extra[def.id] = res.value;
      if (res.newLookup) r.newLookups.push(res.newLookup);
    }
  });

  const filled = Object.keys(r.text).length + Object.keys(r.lookups).length + Object.keys(r.extra).length;
  if (!filled && !sv) r.empty = true;
  return r;
}

const defaultStatusKey = (ctx, defaults) =>
  (ctx.statuses.find((s) => s.key === defaults.status) || ctx.statuses[0])?.key;
const defaultStatusLabel = (ctx, defaults) =>
  (ctx.statuses.find((s) => s.key === defaults.status) || ctx.statuses[0])?.label;

// ---------------- существующая техника ----------------
async function loadDevices(db) {
  const sel = [
    'd.id', 'd.type_id', 't.code AS type_code', 't.name AS type_name', 'd.status', 'd.extra',
    ...TEXT_FIELDS.map((f) => 'd.' + f.key),
    ...LOOKUP_FIELDS.flatMap((f) => [`d.${f.col}`, `l_${f.key}.value AS ${f.key}`]),
  ];
  const joins = LOOKUP_FIELDS.map((f) => `LEFT JOIN lookups l_${f.key} ON l_${f.key}.id = d.${f.col}`).join(' ');
  const { rows } = await db.query(`SELECT ${sel.join(', ')} FROM devices d JOIN device_types t ON t.id = d.type_id ${joins}`);
  return rows;
}

function buildIndex(devices, matchFields) {
  const idx = {};
  for (const f of matchFields) {
    idx[f] = new Map();
    for (const d of devices) {
      const raw = /^f_\d+$/.test(f) ? d.extra?.[f.slice(2)] : d[f];
      const k = matchKey(f, raw);
      if (!k) continue;
      if (!idx[f].has(k)) idx[f].set(k, []);
      idx[f].get(k).push(d);
    }
  }
  return idx;
}

const fieldLabel = (key, ctx) => {
  if (key === 'type') return 'Тип';
  if (key === 'status') return 'Состояние';
  if (/^f_\d+$/.test(key)) return ctx.defById.get(key.slice(2))?.label || key;
  return CORE_FIELDS.find((f) => f.key === key)?.label || key;
};

/** Значения строки файла в виде { key: текст } (для сравнения и показа) */
function rowValues(r, ctx) {
  const out = {};
  if (r.typeFromFile) out.type = r.typeFromFile.name;
  if (r.status) out.status = ctx.statuses.find((s) => s.key === r.status)?.label;
  for (const [k, v] of Object.entries(r.text)) out[k] = v;
  for (const [k, v] of Object.entries(r.lookups)) out[k] = v.value;
  for (const [k, v] of Object.entries(r.extra)) out['f_' + k] = v;
  return out;
}

function deviceValue(d, key, ctx) {
  if (key === 'type') return d.type_name;
  if (key === 'status') return ctx.statuses.find((s) => s.key === d.status)?.label || d.status;
  if (/^f_\d+$/.test(key)) return d.extra?.[key.slice(2)] ?? '';
  return d[key] ?? '';
}

/** Разница между строкой файла и устройством */
function diffWith(vals, d, ctx) {
  const diff = [];
  for (const [k, v] of Object.entries(vals)) {
    const old = deviceValue(d, k, ctx);
    if (lc(old) !== lc(v)) diff.push({ key: k, label: fieldLabel(k, ctx), old: old === '' ? null : String(old), new: v });
  }
  return diff;
}

// ---------------- общая подготовка (preview и commit) ----------------
async function analyze(db, body) {
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_IMPORT_ROWS) : [];
  const columns = Array.isArray(body.columns) ? body.columns.map((c) => String(c || '')) : [];
  const defaults = body.defaults || {};
  if (!rows.length) throw new HttpError(400, 'В файле нет строк с данными');
  if (!columns.some((c) => c && c !== 'skip')) throw new HttpError(400, 'Укажите, в какие поля загружать хотя бы одну колонку');

  const ctx = await loadContext(db);
  const catalog = targetCatalog(ctx);
  const matchable = new Set(catalog.filter((t) => t.matchable).map((t) => t.key));
  const matchFields = (Array.isArray(body.matchFields) ? body.matchFields : [])
    .filter((f) => matchable.has(f) && columns.includes(f));

  const devices = await loadDevices(db);
  const idx = buildIndex(devices, matchFields);
  const seen = matchFields.map(() => new Map()); // повторы внутри файла

  const result = rows.map((cells, i) => {
    const r = resolveRow(Array.isArray(cells) ? cells : [], columns, ctx, defaults);
    const vals = rowValues(r, ctx);
    // Совпадения с базой: устройство → поля, по которым совпало
    const hits = new Map();
    matchFields.forEach((f, fi) => {
      const raw = /^f_\d+$/.test(f) ? r.extra[f.slice(2)] : (r.text[f] ?? '');
      const k = matchKey(f, raw);
      if (!k) return;
      for (const d of idx[f].get(k) || []) {
        if (!hits.has(d.id)) hits.set(d.id, { d, by: [] });
        hits.get(d.id).by.push(fieldLabel(f, ctx));
      }
      if (seen[fi].has(k) && r.dupOf == null) r.dupOf = seen[fi].get(k);
      else if (!seen[fi].has(k)) seen[fi].set(k, i);
    });
    const matches = [...hits.values()]
      .sort((a, b) => b.by.length - a.by.length)
      .slice(0, 5)
      .map(({ d, by }) => {
        const diff = diffWith(vals, d, ctx).filter((x) => x.key !== 'type');
        return {
          id: d.id, key: `${d.type_code}-${d.id}`, title: d.hostname || d.model || d.type_name,
          by, identical: diff.length === 0, diff,
          typeDiffers: r.typeFromFile && r.typeFromFile.id !== d.type_id ? d.type_name : null,
        };
      });
    return { r, vals, matches };
  });
  return { ctx, catalog, matchFields, result, defaults, columns };
}

// ---------------- маршруты ----------------
router.post('/parse', ah(async (req, res) => {
  const { filename, data } = req.body || {};
  if (!data) throw new HttpError(400, 'Файл не получен');
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length > 20 * 1024 * 1024) throw new HttpError(400, 'Файл больше 20 МБ');
  const sheets = readSpreadsheet(buf, String(filename || ''));
  res.json({ sheets: sheets.filter((s) => s.rows.length) });
}));

router.get('/targets', ah(async (req, res) => {
  const ctx = await loadContext({ query });
  const saved = await query('SELECT header, target FROM import_mappings');
  res.json({
    targets: targetCatalog(ctx),
    mappings: Object.fromEntries(saved.rows.map((r) => [r.header, r.target])),
  });
}));

router.post('/preview', ah(async (req, res) => {
  const { ctx, result } = await analyze({ query }, req.body);
  const newLookups = {};
  const kindName = Object.fromEntries((await query('SELECT code, name FROM lookup_kinds')).rows.map((k) => [k.code, k.name]));
  for (const { r } of result) {
    if (r.errors.length) continue; // строки с ошибками не загружаются — их значения не добавятся
    for (const nl of r.newLookups) {
      const name = kindName[nl.kind] || nl.kind;
      (newLookups[name] ||= new Map()).set(lc(nl.value), nl.value);
    }
  }
  res.json({
    rows: result.map(({ r, vals, matches }) => ({
      errors: r.errors, warnings: r.warnings, empty: !!r.empty, dupOf: r.dupOf ?? null,
      type: r.type?.name || null,
      values: Object.entries(vals).map(([k, v]) => ({ key: k, label: fieldLabel(k, ctx), value: v })),
      matches,
    })),
    newLookups: Object.fromEntries(Object.entries(newLookups).map(([k, m]) => [k, [...m.values()]])),
  });
}));

router.post('/commit', ah(async (req, res) => {
  const body = req.body || {};
  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  const mergeMode = body.mergeMode === 'overwrite' ? 'overwrite' : 'fill';
  const filename = String(body.filename || 'файл').slice(0, 200);
  const userId = req.user.id;

  const summary = await tx(async (db) => {
    const { ctx, result, defaults } = await analyze(db, body);
    const out = { created: [], merged: [], skipped: 0, failed: [] };

    // Проверяем, что по каждому совпадению принято решение
    result.forEach(({ r, matches }, i) => {
      if (r.errors.length || r.empty) return;
      const dec = decisions[i];
      if ((matches.length || r.dupOf != null) && !(dec && ['new', 'merge', 'skip'].includes(dec.action))) {
        throw new HttpError(400, `Строка ${i + 1}: выберите, добавить новую технику или объединить с существующей`);
      }
    });

    // Создание недостающих значений справочников (без дублей с учётом регистра)
    const lookupId = async (kind, value) => {
      const ex = ctx.lk.get(kind)?.get(lc(value));
      if (ex) return ex.id;
      const { rows } = await db.query(
        `INSERT INTO lookups (kind, value) VALUES ($1, $2)
         ON CONFLICT (kind, value) DO UPDATE SET value = EXCLUDED.value RETURNING id, value`, [kind, value]);
      if (!ctx.lk.has(kind)) ctx.lk.set(kind, new Map());
      ctx.lk.get(kind).set(lc(value), rows[0]);
      return rows[0].id;
    };
    const ensureCustomLookups = async (r) => {
      for (const nl of r.newLookups) {
        if (LOOKUP_FIELDS.some((f) => f.lookup === nl.kind && r.lookups[f.key]?.value === nl.value)) continue;
        await lookupId(nl.kind, nl.value);
      }
    };
    const history = (id, action, changes) => db.query(
      'INSERT INTO device_history (device_id, user_id, action, changes) VALUES ($1, $2, $3, $4)',
      [id, userId, action, JSON.stringify(changes)]);
    const applicable = (typeId) => new Set(ctx.defs
      .filter((d) => d.scope === 'all' || d.type_id === typeId).map((d) => String(d.id)));

    for (let i = 0; i < result.length; i++) {
      const { r, vals, matches } = result[i];
      if (r.empty) { out.skipped++; continue; }
      if (r.errors.length) { out.failed.push({ row: i, errors: r.errors }); continue; }
      const dec = decisions[i] || { action: 'new' };
      if (dec.action === 'skip') { out.skipped++; continue; }

      if (dec.action === 'merge') {
        const targetId = Number(dec.target);
        const m = matches.find((x) => x.id === targetId);
        const cur = (await db.query('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [targetId])).rows[0];
        if (!cur || !m) { out.failed.push({ row: i, errors: ['Устройство для объединения не найдено'] }); continue; }
        await ensureCustomLookups(r);
        const set = {};
        const written = new Set(); // ключи полей, которые реально записываются
        const empty = (v) => v == null || v === '';
        for (const [k, v] of Object.entries(r.text)) {
          if (mergeMode === 'overwrite' || empty(cur[k])) { set[k] = v; written.add(k); }
        }
        for (const f of LOOKUP_FIELDS) {
          const lv = r.lookups[f.key];
          if (lv && (mergeMode === 'overwrite' || empty(cur[f.col]))) {
            set[f.col] = lv.id ?? await lookupId(f.lookup, lv.value);
            written.add(f.key);
          }
        }
        if (r.status && mergeMode === 'overwrite') { set.status = r.status; written.add('status'); }
        const allowed = applicable(cur.type_id);
        const extra = { ...(cur.extra || {}) };
        for (const [k, v] of Object.entries(r.extra)) {
          if (!allowed.has(String(k))) continue;
          if (mergeMode === 'overwrite' || empty(extra[k])) { extra[k] = v; written.add('f_' + k); }
        }
        if ([...written].some((k) => k.startsWith('f_'))) set.extra = JSON.stringify(extra);
        // В историю — только поля, которые действительно изменились
        const changes = {};
        for (const x of m.diff) if (written.has(x.key)) changes[x.label] = [x.old, x.new];
        if (Object.keys(set).length) {
          const keys = Object.keys(set);
          await db.query(
            `UPDATE devices SET ${keys.map((k, j) => `${k} = $${j + 1}`).join(', ')}, updated_at = now(), updated_by = $${keys.length + 1}
              WHERE id = $${keys.length + 2}`,
            [...keys.map((k) => set[k]), userId, targetId]);
        }
        if (Object.keys(changes).length) {
          await history(targetId, 'updated', { ...changes, 'Импорт из файла': [null, filename] });
        }
        out.merged.push({ row: i, id: targetId, key: m.key, changed: Object.keys(changes).length });
        continue;
      }

      // Новое устройство
      await ensureCustomLookups(r);
      const cols = {
        type_id: r.type.id,
        status: r.status || defaultStatusKey(ctx, defaults),
        ...r.text,
        created_by: userId, updated_by: userId,
      };
      for (const f of LOOKUP_FIELDS) {
        const lv = r.lookups[f.key];
        if (lv) cols[f.col] = lv.id ?? await lookupId(f.lookup, lv.value);
      }
      const allowed = applicable(r.type.id);
      cols.extra = JSON.stringify(Object.fromEntries(Object.entries(r.extra).filter(([k]) => allowed.has(String(k)))));
      const keys = Object.keys(cols);
      const ins = await db.query(
        `INSERT INTO devices (${keys.join(', ')}) VALUES (${keys.map((_, j) => '$' + (j + 1)).join(', ')}) RETURNING id`,
        keys.map((k) => cols[k]));
      const id = ins.rows[0].id;
      await history(id, 'created', { 'Импорт из файла': [null, filename] });
      out.created.push({ row: i, id, key: `${r.type.code}-${id}`, title: vals.hostname || vals.model || r.type.name });
    }

    // Запомнить соответствия колонок
    if (Array.isArray(body.remember)) {
      for (const m of body.remember.slice(0, 200)) {
        const h = normHeader(m.header);
        if (!h || typeof m.target !== 'string') continue;
        await db.query(
          `INSERT INTO import_mappings (header, target, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (header) DO UPDATE SET target = EXCLUDED.target, updated_at = now()`, [h, m.target.slice(0, 50)]);
      }
    }
    return out;
  });
  res.json(summary);
}));

module.exports = router;
module.exports.normHeader = normHeader;
