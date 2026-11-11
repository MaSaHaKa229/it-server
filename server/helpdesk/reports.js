// Отчёты по заявкам helpdesk (раздел «Заявки» → «Отчёты») и выгрузка в Excel.
// Период — по дате создания заявки (поступило) и по дате закрытия (закрыто).
const express = require('express');
const ExcelJS = require('exceljs');
const { HttpError, ah } = require('../inventory/util');
const L = require('./lib');

const { query } = L;
const router = express.Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function period(q) {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = DAY.test(String(q.from || '')) ? q.from : iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = DAY.test(String(q.to || '')) ? q.to : iso(now);
  if (from > to) throw new HttpError(400, 'Начало периода позже окончания');
  return { from, to };
}

// Имя исполнителя: служебная учётная запись — «Служба ИТ»
const EXEC_NAME = `CASE WHEN u.role = 'superadmin' THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END`;
// Отдел заявителя: из справочника, иначе как написал сотрудник
const DEP_NAME = `COALESCE(ld.value, NULLIF(r.department, ''), 'Не указан')`;
// Время решения в часах
const HOURS = `extract(epoch FROM (t.closed_at - t.created_at)) / 3600`;

async function build(from, to) {
  const vals = [from, to];
  // Заявки, поступившие в периоде (c), и закрытые в периоде (x)
  const C = `t.created_at >= $1::date AND t.created_at < $2::date + 1`;
  const X = `t.closed_at >= $1::date AND t.closed_at < $2::date + 1`;
  const BASE = `FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN requesters r ON r.id = t.requester_id
                LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN public.users u ON u.id = t.assignee_id
                LEFT JOIN public.lookups ld ON ld.id = r.department_id`;
  const agg = `count(*) FILTER (WHERE ${C})::int AS created,
               count(*) FILTER (WHERE ${X})::int AS closed,
               count(*) FILTER (WHERE NOT s.is_closed)::int AS open_now,
               count(*) FILTER (WHERE NOT s.is_closed AND t.due_at < now())::int AS overdue_now,
               round(avg(${HOURS}) FILTER (WHERE ${X})::numeric, 1)::float AS avg_hours,
               count(*) FILTER (WHERE ${X} AND t.due_at IS NOT NULL)::int AS with_due,
               count(*) FILTER (WHERE ${X} AND t.due_at IS NOT NULL AND t.closed_at <= t.due_at)::int AS on_time`;
  const group = (key, name) => query(
    `SELECT ${key} AS key, ${name} AS name, ${agg} ${BASE}
      WHERE (${C}) OR (${X}) OR NOT s.is_closed GROUP BY 1, 2 ORDER BY created DESC, 2`, vals);

  const [total, median, byDay, byCat, byDep, byExec, byStatus, byPriority, list] = await Promise.all([
    query(`SELECT ${agg} ${BASE}`, vals),
    query(`SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${HOURS}))::numeric, 1)::float AS median ${BASE} WHERE ${X}`, vals),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
                  (SELECT count(*)::int FROM tickets t WHERE t.created_at >= d AND t.created_at < d + interval '1 day') AS created,
                  (SELECT count(*)::int FROM tickets t WHERE t.closed_at >= d AND t.closed_at < d + interval '1 day') AS closed
             FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`, vals),
    group('c.id', `COALESCE(c.name, 'Без вида')`),
    group(DEP_NAME, DEP_NAME),
    group('t.assignee_id', `COALESCE(${EXEC_NAME}, 'Без исполнителя')`),
    query(`SELECT s.name, s.color, count(*)::int AS n ${BASE} WHERE ${C} GROUP BY s.id, s.name, s.color, s.sort ORDER BY s.sort`, vals),
    query(`SELECT t.priority AS key, count(*)::int AS n ${BASE} WHERE ${C} GROUP BY 1`, vals),
    query(`SELECT t.id, t.title, t.priority, t.created_at, t.closed_at, t.due_at, s.name AS status, s.is_closed,
                  COALESCE(c.name, '') AS category, r.full_name AS requester, ${DEP_NAME} AS department,
                  COALESCE(${EXEC_NAME}, '') AS assignee, round((${HOURS})::numeric, 1)::float AS hours
             ${BASE} WHERE (${C}) OR (${X}) ORDER BY t.created_at`, vals),
  ]);
  return {
    from, to,
    total: { ...total.rows[0], median_hours: median.rows[0].median },
    by_day: byDay.rows,
    by_category: byCat.rows,
    by_department: byDep.rows,
    by_executor: byExec.rows,
    by_status: byStatus.rows,
    by_priority: byPriority.rows.map((r) => ({ ...r, name: L.PRIORITIES[r.key] || r.key })),
    tickets: list.rows,
  };
}

router.get('/', ah(async (req, res) => {
  const { from, to } = period(req.query);
  res.json(await build(from, to));
}));

router.get('/export.xlsx', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const d = await build(from, to);
  const fmt = (s) => s.split('-').reverse().join('.');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IT Portal';
  const head = (ws, row) => {
    const r = ws.getRow(row);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

  // Сводка
  const s = wb.addWorksheet('Сводка');
  s.columns = [{ width: 44 }, { width: 16 }];
  s.addRow([`Отчёт по заявкам за ${fmt(from)} — ${fmt(to)}`]).font = { bold: true, size: 14 };
  s.addRow([]);
  const t = d.total;
  [['Поступило заявок', t.created], ['Закрыто заявок', t.closed], ['Открыто сейчас', t.open_now], ['Просрочено сейчас', t.overdue_now],
    ['Среднее время решения, ч', t.avg_hours ?? '—'], ['Медиана времени решения, ч', t.median_hours ?? '—'],
    ['Закрыто в срок (из закрытых со сроком)', `${t.on_time} из ${t.with_due} (${pct(t.on_time, t.with_due)})`]]
    .forEach((r) => s.addRow(r));
  s.addRow([]);
  s.addRow(['По приоритету (поступившие)', 'Заявок']); head(s, s.rowCount);
  d.by_priority.forEach((r) => s.addRow([r.name, r.n]));
  s.addRow([]);
  s.addRow(['По статусу (поступившие)', 'Заявок']); head(s, s.rowCount);
  d.by_status.forEach((r) => s.addRow([r.name, r.n]));

  const groupSheet = (title, rows, label) => {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [{ header: label, width: 36 }, { header: 'Поступило', width: 12 }, { header: 'Закрыто', width: 12 },
      { header: 'Открыто сейчас', width: 15 }, { header: 'Просрочено сейчас', width: 18 }, { header: 'Среднее время решения, ч', width: 24 },
      { header: 'Закрыто в срок', width: 16 }];
    head(ws, 1);
    rows.forEach((r) => ws.addRow([r.name, r.created, r.closed, r.open_now, r.overdue_now, r.avg_hours ?? '', pct(r.on_time, r.with_due)]));
  };
  groupSheet('По видам проблем', d.by_category, 'Вид проблемы');
  groupSheet('По отделам', d.by_department, 'Отдел');
  groupSheet('По исполнителям', d.by_executor, 'Исполнитель');

  const days = wb.addWorksheet('По дням');
  days.columns = [{ header: 'Дата', width: 12 }, { header: 'Поступило', width: 12 }, { header: 'Закрыто', width: 12 }];
  head(days, 1);
  d.by_day.forEach((r) => days.addRow([fmt(r.day), r.created, r.closed]));

  const list = wb.addWorksheet('Заявки', { views: [{ state: 'frozen', ySplit: 1 }] });
  list.columns = [
    { header: '№', key: 'id', width: 7 }, { header: 'Тема', key: 'title', width: 40 }, { header: 'Вид', key: 'category', width: 20 },
    { header: 'Приоритет', key: 'priority', width: 12 }, { header: 'Статус', key: 'status', width: 14 },
    { header: 'Заявитель', key: 'requester', width: 24 }, { header: 'Отдел', key: 'department', width: 22 },
    { header: 'Исполнитель', key: 'assignee', width: 22 }, { header: 'Создана', key: 'created_at', width: 17 },
    { header: 'Срок', key: 'due_at', width: 17 }, { header: 'Закрыта', key: 'closed_at', width: 17 }, { header: 'Решалась, ч', key: 'hours', width: 12 },
  ];
  head(list, 1);
  d.tickets.forEach((r) => list.addRow({ ...r, priority: L.PRIORITIES[r.priority] || r.priority, due_at: r.due_at || '', closed_at: r.closed_at || '', hours: r.hours ?? '' }));
  ['created_at', 'due_at', 'closed_at'].forEach((k) => { list.getColumn(k).numFmt = 'dd.mm.yyyy hh:mm'; });
  list.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="helpdesk-report-${from}_${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
