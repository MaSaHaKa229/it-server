// Выгрузка списка в Excel (одна таблица): шапка синим, закреплённая первая строка, автофильтр
const ExcelJS = require('exceljs');

/** columns: [{ header, key, width, date?: true|'day' }], rows: массив объектов */
async function sendXlsx(res, filename, sheet, columns, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IT Portal';
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  for (const r of rows) {
    const o = {};
    for (const c of columns) {
      let v = typeof c.get === 'function' ? c.get(r) : r[c.key];
      if (c.date && v) v = new Date(v);
      o[c.key] = v ?? '';
    }
    ws.addRow(o);
  }
  columns.forEach((c) => { if (c.date) ws.getColumn(c.key).numFmt = c.date === 'day' ? 'dd.mm.yyyy' : 'dd.mm.yyyy hh:mm'; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { sendXlsx };
