import { useMemo } from 'react';
import { ABSENCE_KINDS, absenceColor } from '../constants.js';
import { addDays, dateKey, fmtDate, isWeekend, sameDay, startOfDay, startOfWeek, taskEndDay, WEEKDAYS } from '../dates.js';

// Насыщенность дня по числу задач: один оттенок, от светлого к тёмному
const LEVELS = ['#DEEBFF', '#B3D4FF', '#4C9AFF', '#0065FF', '#0747A6'];
const level = (n, max) => (n ? Math.min(LEVELS.length - 1, Math.floor(((n - 1) / Math.max(1, max - 1)) * (LEVELS.length - 1) + 0.0001)) : -1);

const MONTHS = Array.from({ length: 12 }, (_, m) => {
  const s = new Date(2000, m, 1).toLocaleDateString('ru-RU', { month: 'long' });
  return s[0].toUpperCase() + s.slice(1);
});

/** Год: 12 месяцев. Цвет дня — сколько задач на него приходится; полоска снизу — кто-то отсутствует. */
export default function YearView({ year, tasks, absences = [], onDayClick, onMonthClick }) {
  const today = startOfDay(new Date());

  // Подсчёт задач и отсутствий по дням
  const { counts, absByDay, max } = useMemo(() => {
    const counts = new Map();
    const absByDay = new Map();
    const y0 = new Date(year, 0, 1), y1 = new Date(year + 1, 0, 1);
    for (const t of tasks) {
      if (t.status === 'cancelled') continue;
      let d = startOfDay(t.start_at); if (d < y0) d = y0;
      const end = taskEndDay(t);
      for (let i = 0; d <= end && d < y1 && i < 400; i++, d = addDays(d, 1)) counts.set(dateKey(d), (counts.get(dateKey(d)) || 0) + 1);
    }
    for (const a of absences) {
      let d = new Date(a.start_date + 'T00:00:00'); if (d < y0) d = y0;
      const end = new Date(a.end_date + 'T00:00:00');
      for (let i = 0; d <= end && d < y1 && i < 400; i++, d = addDays(d, 1)) {
        const k = dateKey(d);
        if (!absByDay.has(k)) absByDay.set(k, []);
        absByDay.get(k).push(a);
      }
    }
    return { counts, absByDay, max: Math.max(1, ...counts.values()) };
  }, [tasks, absences, year]);

  return (
    <div className="year">
      <div className="year-grid">
        {MONTHS.map((name, m) => {
          const first = new Date(year, m, 1);
          const start = startOfWeek(first);
          const weeks = Math.ceil((((first.getDay() + 6) % 7) + new Date(year, m + 1, 0).getDate()) / 7);
          return (
            <div key={m} className="year-month">
              <button className="year-month-title" onClick={() => onMonthClick(first)} title="Открыть месяц">{name}</button>
              <div className="year-days">
                {WEEKDAYS.map((w, i) => <span key={w} className={`yd-head ${i >= 5 ? 'weekend' : ''}`}>{w}</span>)}
                {Array.from({ length: weeks * 7 }, (_, i) => {
                  const d = addDays(start, i);
                  if (d.getMonth() !== m) return <span key={i} className="yd empty" />;
                  const k = dateKey(d);
                  const n = counts.get(k) || 0;
                  const lv = level(n, max);
                  const abs = absByDay.get(k) || [];
                  const tip = [fmtDate(d, { weekday: 'short', day: 'numeric', month: 'long' }),
                    n ? `задач: ${n}` : 'задач нет',
                    ...abs.map((a) => `${a.user_name} — ${(ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other).label.toLowerCase()}`)].join('\n');
                  return (
                    <button key={i} title={tip} onClick={() => onDayClick(d)}
                      className={`yd ${isWeekend(d) ? 'weekend' : ''} ${sameDay(d, today) ? 'today' : ''} ${lv >= 3 ? 'dark' : ''}`}
                      style={lv >= 0 ? { background: LEVELS[lv] } : undefined}>
                      {d.getDate()}
                      {abs.length > 0 && <i className="yd-abs" style={{ background: absenceColor(abs[0]) }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="legend year-legend">
        <span>Задач в день:</span>
        <span><i style={{ background: '#fff', boxShadow: 'inset 0 0 0 1px #DFE1E6' }} />нет</span>
        {LEVELS.map((c, i) => {
          const a = Math.round(1 + (i / (LEVELS.length - 1)) * (max - 1));
          return <span key={c}><i style={{ background: c }} />{i === LEVELS.length - 1 ? `${a}+` : a}</span>;
        })}
        <span className="year-legend-sep" />
        <span><i className="yd-abs-legend" />кто-то отсутствует (цвет — вид отсутствия)</span>
      </div>
    </div>
  );
}
