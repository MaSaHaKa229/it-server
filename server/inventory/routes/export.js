// Выгрузка техники в Excel (.xlsx) — учитывает поиск, фильтры и права пользователя
const express = require('express');
const ExcelJS = require('exceljs');
const { query } = require('../db');
const { CORE_FIELDS, canSeeField } = require('../access');
const { buildDeviceQuery, sanitizeRow, loadGlobalDefs } = require('../deviceQuery');
const { HttpError, ah, parseJSON } = require('../util');
const { loadSoftwareDefs } = require('../extra');

const router = express.Router();

router.get('/', ah(async (req, res) => {
  const P = req.perms;
  if (!P.export) throw new HttpError(403, 'Выгрузка недоступна для вашей учётной записи');

  const defs = await loadGlobalDefs({ query });
  const b = buildDeviceQuery({
    P, defs,
    q: req.query.q,
    filters: parseJSON(req.query.filters, {}),
    sort: req.query.sort,
    dir: req.query.dir,
    limit: 100000,
  });
  const rows = (await query(b.sql, b.params)).rows.map((r) => sanitizeRow(r, P, b.vis));

  // Доступные колонки
  const all = [
    { key: 'key', header: 'Ключ', width: 10, get: (r) => `${r.type_code}-${r.id}` },
    { key: 'type', header: 'Тип', width: 12, get: (r) => r.type_name },
    { key: 'status', header: 'Состояние', width: 14, get: (r) => r.status_label || r.status },
    ...CORE_FIELDS.filter((f) => canSeeField(P, f.key)).map((f) => ({
      key: f.key, header: f.label, width: f.kind === 'textarea' ? 40 : 20, get: (r) => r[f.key],
    })),
    ...defs.filter((d) => b.vis.visibleIds.has(String(d.id))).map((d) => ({
      key: 'f_' + d.id, header: d.label, width: 18,
      get: (r) => {
        const v = r.extra?.[d.id];
        if (d.field_type === 'bool') return v === 'true' ? 'Да' : v === 'false' ? 'Нет' : null;
        if (d.field_type === 'number' && v != null && v !== '') return Number(String(v).replace(',', '.'));
        return v;
      },
    })),
  ];
  if (P.software) all.push({ key: 'software', header: 'Установленное ПО', width: 50, get: (r) => r.software });
  all.push({ key: 'updated_at', header: 'Изменено', width: 18, get: (r) => r.updated_at });

  let cols = all;
  const wanted = String(req.query.columns || '').split(',').filter(Boolean);
  if (wanted.length) {
    cols = wanted.map((k) => all.find((c) => c.key === k)).filter(Boolean);
    if (!cols.find((c) => c.key === 'key')) cols.unshift(all[0]);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'IT Inventory';
  wb.created = new Date();
  const ws = wb.addWorksheet('Техника', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of rows) {
    const obj = {};
    for (const c of cols) obj[c.key] = c.get(r) ?? '';
    ws.addRow(obj);
  }
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const upd = cols.findIndex((c) => c.key === 'updated_at');
  if (upd >= 0) ws.getColumn(upd + 1).numFmt = 'dd.mm.yyyy hh:mm';

  // Отдельный лист с установленным ПО
  if (P.software && req.query.software_sheet === '1' && rows.length) {
    const ids = rows.map((r) => r.id);
    const sw = await query(
      `SELECT t.code || '-' || d.id AS key, d.hostname, s.name, s.vendor, ds.version, ds.license_key, ds.installed_at, ds.note,
              s.extra AS sw_extra, ds.extra AS inst_extra
         FROM device_software ds
         JOIN software s ON s.id = ds.software_id
         JOIN devices d ON d.id = ds.device_id
         JOIN device_types t ON t.id = d.type_id
        WHERE ds.device_id = ANY($1::int[]) ORDER BY d.id, s.name`, [ids]);
    const ws2 = wb.addWorksheet('Установленное ПО', { views: [{ state: 'frozen', ySplit: 1 }] });
    // Доп. поля ПО: сначала поля программы, затем поля установки
    const swDefs = await loadSoftwareDefs({ query });
    ws2.columns = [
      { header: 'Ключ', key: 'key', width: 10 },
      { header: 'Сетевое имя', key: 'hostname', width: 20 },
      { header: 'Программа', key: 'name', width: 35 },
      { header: 'Производитель', key: 'vendor', width: 20 },
      { header: 'Версия', key: 'version', width: 14 },
      { header: 'Лицензия', key: 'license_key', width: 30 },
      { header: 'Дата установки', key: 'installed_at', width: 14 },
      { header: 'Примечание', key: 'note', width: 30 },
      ...swDefs.map((d) => ({ header: d.label, key: 'sf_' + d.id, width: 18 })),
    ];
    const fmt = (d, v) => {
      if (v == null || v === '') return '';
      if (d.field_type === 'bool') return v === 'true' ? 'Да' : 'Нет';
      if (d.field_type === 'number') return Number(String(v).replace(',', '.'));
      return v;
    };
    for (const r of sw.rows) {
      const { sw_extra: swExtra, inst_extra: instExtra, ...row } = r;
      for (const d of swDefs) row['sf_' + d.id] = fmt(d, (d.target === 'software' ? swExtra : instExtra)?.[d.id]);
      ws2.addRow(row);
    }
    ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
    ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 + swDefs.length } };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="it-inventory-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent('техника-' + stamp + '.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
