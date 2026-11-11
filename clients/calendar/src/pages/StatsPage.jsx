// Статистика по задачам: служба ИТ в целом и каждый сотрудник (только для администраторов календаря)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import { addDays, addMonths, fmtDate, fmtTaskPeriod, fromInputDate, startOfDay, startOfMonth, startOfWeek, toInputDate } from '../dates.js';
import { initials, PRIORITIES } from '../constants.js';
import Icon from '../components/Icon.jsx';
import TaskModal from '../components/TaskModal.jsx';

// Цвета рядов графика (проверены на различимость, в т.ч. при нарушениях цветовосприятия)
const C = { created: '#4C9AFF', done: '#00875A', late: '#FF8B00' };

const PRESETS = [
  ['week', 'Неделя'], ['month', 'Месяц'], ['quarter', 'Квартал'], ['year', 'Год'], ['custom', 'Период'],
];

function rangeFor(preset, anchor) {
  const a = startOfDay(anchor);
  if (preset === 'week') { const f = startOfWeek(a); return [f, addDays(f, 7)]; }
  if (preset === 'month') { const f = startOfMonth(a); return [f, addMonths(f, 1)]; }
  if (preset === 'quarter') { const f = new Date(a.getFullYear(), Math.floor(a.getMonth() / 3) * 3, 1); return [f, addMonths(f, 3)]; }
  const f = new Date(a.getFullYear(), 0, 1); return [f, new Date(a.getFullYear() + 1, 0, 1)];
}
function shiftAnchor(preset, anchor, dir) {
  if (preset === 'week') return addDays(anchor, 7 * dir);
  if (preset === 'month') return addMonths(anchor, dir);
  if (preset === 'quarter') return addMonths(anchor, 3 * dir);
  return new Date(anchor.getFullYear() + dir, 0, 1);
}
function periodTitle(preset, from, to) {
  const last = addDays(to, -1);
  if (preset === 'month') { const s = from.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''); return s[0].toUpperCase() + s.slice(1); }
  if (preset === 'quarter') return `${Math.floor(from.getMonth() / 3) + 1} квартал ${from.getFullYear()}`;
  if (preset === 'year') return `${from.getFullYear()} год`;
  return `${fmtDate(from)} — ${fmtDate(last, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const fmtPct = (v) => (v === null ? '—' : `${v}%`);
function fmtHours(h) {
  if (h === null || h === undefined) return '—';
  if (h < 1) return 'меньше часа';
  if (h < 24) return `${Math.round(h)} ч`;
  return `${(h / 24).toFixed(1).replace('.', ',').replace(',0', '')} дн.`;
}

// ---------- Плитки с ключевыми показателями ----------
function Kpis({ t }) {
  const onTime = pct(t.done_on_time, t.done);
  const dueMet = pct(t.due_met, t.due);
  return (
    <div className="stat-row six">
      <div className="stat"><small>Выполнено</small><b>{t.done}</b>
        <span className="stat-sub">{t.done ? `в срок ${t.done_on_time} · с опозданием ${t.done_late}` : 'за период'}</span></div>
      <div className="stat"><small>Выполнено в срок</small><b>{fmtPct(onTime)}</b>
        <span className="stat-sub">{t.avg_late_hours ? `среднее опоздание ${fmtHours(t.avg_late_hours)}` : 'от выполненных за период'}</span></div>
      <div className="stat"><small>Соблюдение сроков</small><b>{fmtPct(dueMet)}</b>
        <span className="stat-sub">{t.due ? `${t.due_met} из ${t.due} задач со сроком в периоде` : 'сроков в периоде не было'}</span></div>
      <div className="stat"><small>Время выполнения</small><b>{fmtHours(t.median_lead_hours)}</b>
        <span className="stat-sub">{t.avg_lead_hours !== null ? `медиана; в среднем ${fmtHours(t.avg_lead_hours)}` : 'от создания до выполнения'}</span></div>
      <div className="stat"><small>Создано / в плане</small><b>{t.created} <span className="stat-of">/ {t.planned}</span></b>
        <span className="stat-sub">{t.cancelled ? `отменено ${t.cancelled}` : 'новых и запланированных'}</span></div>
      <div className={`stat ${t.overdue_now ? 'danger' : ''}`}><small>Открыто сейчас</small><b>{t.open_now}</b>
        <span className="stat-sub">{t.overdue_now ? `просрочено ${t.overdue_now}` : 'просроченных нет'} · в работе {t.in_progress_now}</span></div>
    </div>
  );
}

// ---------- График «создано / выполнено» ----------
function bucketLabel(d, step, long) {
  const x = new Date(d);
  if (step === 'month') return x.toLocaleDateString('ru-RU', long ? { month: 'long', year: 'numeric' } : { month: 'short' }).replace(' г.', '');
  if (step === 'week') return long ? `неделя с ${fmtDate(x)}` : x.toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' });
  return long ? fmtDate(x, { weekday: 'short', day: 'numeric', month: 'long' }) : String(x.getDate());
}
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
}

function TrendChart({ trend, step }) {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 220, L = 36, R = 8, T = 10, B = 26;
  const n = trend.length || 1;
  const max = niceMax(Math.max(1, ...trend.map((b) => Math.max(b.created, b.done))));
  const band = (w - L - R) / n;
  const bw = Math.max(2, Math.min(18, (band - 6) / 2));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((v) => Number.isInteger(v));
  const every = Math.ceil(n / Math.max(1, Math.floor((w - L) / 44)));
  const empty = !trend.some((b) => b.created || b.done);

  // Столбик со скруглённой верхушкой (4px) и прямым основанием
  const bar = (x, y0, y1, color, key) => {
    const h = y0 - y1;
    if (h <= 0) return null;
    const r = Math.min(4, h, bw / 2);
    return <path key={key} fill={color} d={`M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y0}Z`} />;
  };

  const hb = hover !== null ? trend[hover] : null;
  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={H} role="img" aria-label="Создано и выполнено задач по периодам">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} className={v ? 'grid' : 'axis'} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
          </g>
        ))}
        {trend.map((b, i) => {
          const x0 = L + i * band + (band - 2 * bw - 2) / 2;
          const onTime = b.done - b.done_late;
          return (
            <g key={b.start}>
              {hover === i && <rect x={L + i * band} y={T} width={band} height={H - T - B} className="hover-band" />}
              {bar(x0, y(0), y(b.created), C.created, 'c')}
              {/* Выполнено: в срок снизу, с опозданием сверху, между ними — зазор 2px */}
              {b.done_late && onTime
                ? [bar(x0 + bw + 2, y(0), y(onTime), C.done, 'd'), bar(x0 + bw + 2, y(onTime) - 2, Math.min(y(b.done), y(onTime) - 3), C.late, 'l')]
                : bar(x0 + bw + 2, y(0), y(b.done), b.done_late ? C.late : C.done, 'd')}
              {i % every === 0 && <text x={L + i * band + band / 2} y={H - 8} textAnchor="middle" className="tick">{bucketLabel(b.start, step)}</text>}
              <rect x={L + i * band} y={T} width={band} height={H - T} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          );
        })}
        {empty && <text x={(w + L) / 2} y={H / 2} textAnchor="middle" className="tick">За период задач нет</text>}
      </svg>
      {hb && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(L + hover * band + band / 2, 90), w - 90) }}>
          <b>{bucketLabel(hb.start, step, true)}</b>
          <span><i style={{ background: C.created }} />Создано: {hb.created}</span>
          <span><i style={{ background: C.done }} />Выполнено в срок: {hb.done - hb.done_late}</span>
          <span><i style={{ background: C.late }} />С опозданием: {hb.done_late}</span>
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: C.created }} />Создано</span>
        <span><i style={{ background: C.done }} />Выполнено в срок</span>
        <span><i style={{ background: C.late }} />Выполнено с опозданием</span>
      </div>
    </div>
  );
}

// ---------- Таблицы ----------
const COLS = [
  { k: 'created', label: 'Создано', hint: 'Новые задачи за период' },
  { k: 'planned', label: 'В плане', hint: 'Задачи, которые приходятся на период (кроме отменённых)', sm: true },
  { k: 'done', label: 'Выполнено', hint: 'Переведены в «Выполнено» за период', bar: true },
  { k: 'on_time', label: 'В срок', hint: 'Доля выполненных не позже срока', get: (r) => pct(r.done_on_time, r.done), fmt: fmtPct },
  { k: 'due_rate', label: 'Сроки', hint: 'Сколько задач со сроком в периоде выполнено вовремя', get: (r) => pct(r.due_met, r.due), fmt: fmtPct, sm: true },
  { k: 'open_now', label: 'Открыто', hint: 'Не выполнено сейчас (к выполнению и в работе)' },
  { k: 'overdue_now', label: 'Просрочено', hint: 'Открытые задачи с прошедшим сроком', danger: true },
  { k: 'median_lead_hours', label: 'Время выполн.', hint: 'Медиана: от создания до выполнения', fmt: fmtHours, sm: true },
];
const val = (c, r) => (c.get ? c.get(r) : r[c.k]);
const show = (c, r) => { const v = val(c, r); return c.fmt ? c.fmt(v) : v; };

function MetricCells({ r, maxDone }) {
  return COLS.map((c) => (
    <td key={c.k} className={`num ${c.sm ? 'hide-sm' : ''} ${c.danger && r[c.k] ? 'danger' : ''}`}>
      {c.bar ? <div className="load"><div style={{ width: `${(r.done / (maxDone || 1)) * 100}%`, background: C.done }} /><span>{r.done}</span></div> : show(c, r)}
    </td>
  ));
}

function useSort(initial) {
  const [sort, setSort] = useState(initial);
  const th = (key, label, extra = {}) => (
    <th key={key} className={`sortable ${extra.className || ''}`} title={extra.title} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : (key === 'name' ? 1 : -1) }))}>
      {label}{sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return [sort, th];
}

function EmployeesTable({ rows, unassigned, totals, onPick }) {
  const [sort, th] = useSort({ key: 'done', dir: -1 });
  const sorted = useMemo(() => {
    const c = COLS.find((x) => x.k === sort.key);
    const get = (r) => (sort.key === 'name' ? r.name : val(c, r) ?? -1);
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * sort.dir || a.name.localeCompare(b.name, 'ru');
    });
  }, [rows, sort]);
  const maxDone = Math.max(1, ...rows.map((r) => r.done));
  return (
    <div className="table-scroll">
      <table className="table stats-table">
        <thead><tr>{th('name', 'Сотрудник')}{COLS.map((c) => th(c.k, c.label, { title: c.hint, className: `num ${c.sm ? 'hide-sm' : ''}` }))}</tr></thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} className={`clickable ${r.is_active ? '' : 'inactive'}`} onClick={() => onPick(r.id)} title="Подробная статистика сотрудника">
              <td><span className="person"><span className="avatar sm" style={{ background: r.color }}>{initials(r.name)}</span>
                <span>{r.name}{!r.is_active && <small className="muted"> (заблокирован)</small>}</span></span></td>
              <MetricCells r={r} maxDone={maxDone} />
            </tr>
          ))}
          {unassigned && (unassigned.open_now || unassigned.done || unassigned.created) ? (
            <tr className="muted-row">
              <td><span className="person"><span className="avatar sm" style={{ background: '#97A0AF' }}>?</span>Без исполнителя</span></td>
              <MetricCells r={unassigned} maxDone={maxDone} />
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr><td>Служба в целом</td>{COLS.map((c) => <td key={c.k} className={`num ${c.sm ? 'hide-sm' : ''}`}>{show(c, totals)}</td>)}</tr>
        </tfoot>
      </table>
      <p className="hint pad-x">Задача с несколькими исполнителями учитывается у каждого, а в строке «Служба в целом» — один раз. Нажмите на сотрудника, чтобы открыть его статистику.</p>
    </div>
  );
}

function BreakdownTable({ title, rows, label }) {
  const maxDone = Math.max(1, ...rows.map((r) => r.done));
  return (
    <div className="card flush">
      <h3 className="pad-h">{title}</h3>
      {rows.length ? (
        <div className="table-scroll">
          <table className="table stats-table">
            <thead><tr><th>{label}</th><th className="num">Создано</th><th className="num">Выполнено</th><th className="num">В срок</th><th className="num">Открыто</th><th className="num">Просрочено</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><span className="person"><i className="dot" style={{ background: r.color }} />{r.name}</span></td>
                  <td className="num">{r.created}</td>
                  <td className="num"><div className="load"><div style={{ width: `${(r.done / maxDone) * 100}%`, background: C.done }} /><span>{r.done}</span></div></td>
                  <td className="num">{fmtPct(pct(r.done_on_time, r.done))}</td>
                  <td className="num">{r.open_now}</td>
                  <td className={`num ${r.overdue_now ? 'danger' : ''}`}>{r.overdue_now}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted pad">Нет данных за период</p>}
    </div>
  );
}

function TaskList({ title, tasks, empty, onOpen, mode }) {
  const [all, setAll] = useState(false);
  const LIMIT = 10;
  return (
    <div className="card">
      <h3>{title} {tasks.length ? <span className="badge">{tasks.length}</span> : null}</h3>
      {tasks.length ? (all ? tasks : tasks.slice(0, LIMIT)).map((t) => {
        const late = t.completed_at ? new Date(t.completed_at) - new Date(t.deadline) : Date.now() - new Date(t.deadline);
        return (
          <button key={t.id} className="mini-task" onClick={() => onOpen(t.id)} style={{ '--c': t.category_color || '#64748b' }}>
            <b>{t.title}</b>
            <small>
              {mode === 'done' ? `выполнено ${fmtDate(t.completed_at)}` : fmtTaskPeriod(t)}
              {late > 0 && mode !== 'done' ? ` · опоздание ${fmtHours(late / 3600000)}` : ''}
              {late > 0 && mode === 'done' ? ' · с опозданием' : ''}
            </small>
            <span className="pill" style={{ '--p': PRIORITIES[t.priority].color }}>{PRIORITIES[t.priority].label}</span>
          </button>
        );
      }) : <p className="muted">{empty}</p>}
      {tasks.length > LIMIT && (
        <button className="btn small ghost" onClick={() => setAll((x) => !x)}>{all ? 'Свернуть' : `Показать все (${tasks.length})`}</button>
      )}
    </div>
  );
}

// ---------- Выгрузка в CSV (открывается в Excel) ----------
function downloadCsv(name, header, rows) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = '﻿' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const CSV_HEAD = ['Создано', 'В плане', 'Выполнено', 'В срок', 'С опозданием', '% в срок', 'Сроков в периоде', 'Соблюдено', 'Отменено',
  'Открыто сейчас', 'Просрочено сейчас', 'Медиана выполнения, ч', 'Среднее выполнение, ч', 'Среднее опоздание, ч'];
const csvRow = (r) => [r.created, r.planned, r.done, r.done_on_time, r.done_late, pct(r.done_on_time, r.done) ?? '', r.due, r.due_met, r.cancelled,
  r.open_now, r.overdue_now, r.median_lead_hours ?? '', r.avg_lead_hours ?? '', r.avg_late_hours ?? ''].map((v) => String(v).replace('.', ','));

// ---------- Страница ----------
export default function StatsPage() {
  const { categories, users, toast } = useApp();
  const [preset, setPreset] = useState('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [custom, setCustom] = useState(() => ({ from: toInputDate(addDays(new Date(), -29)), to: toInputDate(new Date()) }));
  const [category, setCategory] = useState('');
  const [userId, setUserId] = useState(() => Number(new URLSearchParams(window.location.hash.split('?')[1]).get('user')) || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [reload, setReload] = useState(0);

  const [from, to] = useMemo(() => {
    if (preset !== 'custom') return rangeFor(preset, anchor);
    const f = custom.from ? fromInputDate(custom.from) : startOfDay(new Date());
    const t = custom.to ? addDays(fromInputDate(custom.to), 1) : addDays(f, 1);
    return [f, t > f ? t : addDays(f, 1)];
  }, [preset, anchor, custom]);

  // Выбранный сотрудник — в адресе страницы (#/stats?user=5), чтобы работала кнопка «Назад»
  useEffect(() => {
    const on = () => setUserId(Number(new URLSearchParams(window.location.hash.split('?')[1]).get('user')) || '');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const pick = (id) => { window.location.hash = id ? `#/stats?user=${id}` : '#/stats'; };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/report' + qs({ from, to, category, user: userId }))
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) { toast(e.message, 'err'); if (e.status === 404 && userId) pick(''); } })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [from, to, category, userId, reload, toast]);

  const people = useMemo(() => users.filter((u) => u.is_active), [users]);
  const title = periodTitle(preset, from, to);
  const fileTag = `${toInputDate(from)}_${toInputDate(addDays(to, -1))}`;

  const exportCsv = () => {
    if (!data) return;
    if (data.user) {
      downloadCsv(`stats_user${data.user.id}_${fileTag}.csv`,
        ['Задача', 'Категория', 'Приоритет', 'Срок', 'Выполнено', 'Опоздание, ч'],
        data.done.map((t) => [t.title, t.category_name || '', PRIORITIES[t.priority].label, new Date(t.deadline).toLocaleString('ru-RU'),
          new Date(t.completed_at).toLocaleString('ru-RU'),
          Math.max(0, Math.round((new Date(t.completed_at) - new Date(t.deadline)) / 360000) / 10).toString().replace('.', ',')]));
    } else {
      downloadCsv(`stats_department_${fileTag}.csv`, ['Сотрудник', ...CSV_HEAD], [
        ...data.employees.map((e) => [e.name, ...csvRow(e)]),
        ['Без исполнителя', ...csvRow(data.unassigned)],
        ['Служба в целом', ...csvRow(data.totals)],
      ]);
    }
  };

  const catRows = (data?.byCategory || []).map((c) => ({ ...c, key: c.id ?? 'none' }));
  const prioRows = Object.entries(PRIORITIES).map(([k, p]) => {
    const r = data?.byPriority.find((x) => x.priority === k);
    return r && { ...r, key: k, name: p.label, color: p.color };
  }).filter(Boolean).reverse();

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          {data?.user ? (
            <>
              <div className="breadcrumbs"><a href="#/stats" onClick={(e) => { e.preventDefault(); pick(''); }}>Статистика службы ИТ</a><span className="sep">/</span></div>
              <h2 className="person big"><span className="avatar" style={{ background: data.user.color }}>{initials(data.user.name)}</span>{data.user.name}</h2>
            </>
          ) : <h2>Статистика службы ИТ</h2>}
          <p className="muted">{title}{category ? ` · ${categories.find((c) => String(c.id) === category)?.name || ''}` : ''}</p>
        </div>
        <div className="toolbar-right">
          <button className="btn" onClick={exportCsv} disabled={!data} title="Скачать таблицу для Excel"><Icon name="download" size={16} /> В Excel (CSV)</button>
        </div>
      </header>

      <div className="toolbar stats-toolbar">
        <div className="toolbar-left">
          <div className="segmented">
            {PRESETS.map(([k, l]) => <button key={k} className={preset === k ? 'active' : ''} onClick={() => setPreset(k)}>{l}</button>)}
          </div>
          {preset === 'custom' ? (
            <span className="input-row dates">
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="С" />
              <span className="muted">—</span>
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="По" />
            </span>
          ) : (
            <span className="btn-group">
              <button className="icon-btn" onClick={() => setAnchor((a) => shiftAnchor(preset, a, -1))} aria-label="Предыдущий период"><Icon name="left" /></button>
              <button className="btn ghost" onClick={() => setAnchor(new Date())}>Текущий</button>
              <button className="icon-btn" onClick={() => setAnchor((a) => shiftAnchor(preset, a, 1))} aria-label="Следующий период"><Icon name="right" /></button>
            </span>
          )}
        </div>
        <div className="filters">
          <select value={userId} onChange={(e) => pick(Number(e.target.value) || '')} aria-label="Сотрудник">
            <option value="">Вся служба ИТ</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Категория">
            <option value="">Все категории</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {loading && <span className="spinner small" />}
        </div>
      </div>

      {!data ? <div className="spinner" /> : (
        <>
          <Kpis t={data.totals} />

          <div className="card">
            <h3>Создано и выполнено {data.period.step === 'day' ? 'по дням' : data.period.step === 'week' ? 'по неделям' : 'по месяцам'}</h3>
            <TrendChart trend={data.trend} step={data.period.step} />
          </div>

          {!data.user && (
            <div className="card flush">
              <h3 className="pad-h">По сотрудникам</h3>
              <EmployeesTable rows={data.employees} unassigned={data.unassigned} totals={data.totals} onPick={pick} />
            </div>
          )}

          {data.user && (
            <div className="two-col">
              <TaskList title="Просрочено сейчас" tasks={data.overdue} empty="Просроченных задач нет" onOpen={setOpen} />
              <TaskList title="Выполнено с опозданием" tasks={data.late} empty="Все задачи за период выполнены в срок" onOpen={setOpen} mode="late" />
            </div>
          )}

          <div className="two-col">
            <BreakdownTable title="По категориям" rows={catRows} label="Категория" />
            <BreakdownTable title="По приоритетам" rows={prioRows} label="Приоритет" />
          </div>

          {data.user && <TaskList title="Выполнено за период" tasks={data.done} empty="За период ничего не выполнено" onOpen={setOpen} mode="done" />}

          <details className="card how">
            <summary>Как считаются показатели</summary>
            <ul>
              <li><b>Выполнено</b> — задачи, переведённые в статус «Выполнено» в выбранном периоде (в том числе из заявок).</li>
              <li><b>В срок</b> — выполнено не позже окончания задачи; у задачи «на весь день» срок — конец последнего дня.</li>
              <li><b>Соблюдение сроков</b> — из задач, срок которых пришёлся на период (и уже наступил), сколько выполнено вовремя. Отменённые не учитываются.</li>
              <li><b>Время выполнения</b> — от создания задачи до её выполнения; медиана меньше зависит от единичных «долгих» задач, чем среднее.</li>
              <li><b>В плане</b> — задачи, даты которых приходятся на период, кроме отменённых.</li>
              <li><b>Открыто и просрочено сейчас</b> — текущее состояние, от выбранного периода не зависит.</li>
              <li>Для задач, выполненных до обновления портала, дата выполнения взята из журнала действий, а если её там нет — по дате последнего изменения задачи.</li>
            </ul>
          </details>
        </>
      )}

      {open && <TaskModal taskId={open} onClose={() => setOpen(null)} onChanged={() => setReload((x) => x + 1)} />}
    </div>
  );
}
