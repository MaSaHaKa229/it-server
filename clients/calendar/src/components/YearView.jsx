import { useMemo } from 'react';
import { ABSENCE_KINDS, absenceColor, PRIORITIES } from '../constants.js';
import { addDays, dateKey, fmtDate, isWeekend, sameDay, startOfDay, startOfWeek, taskEndDay, WEEKDAYS } from '../dates.js';

// Приоритеты — от важного к неважному (так и выводятся метки в ячейке дня)
const PRIO_ORDER = ['critical', 'high', 'normal', 'low'];
const num = (n) => (n > 99 ? '99+' : String(n));

const MONTHS = Array.from({ length: 12 }, (_, m) => {
  const s = new Date(2000, m, 1).toLocaleDateString('ru-RU', { month: 'long' });
  return s[0].toUpperCase() + s.slice(1);
});

/**
 * Год: 12 месяцев. В ячейке дня — сколько задач всего (справа сверху) и сколько каждого приоритета
 * (цветные метки снизу, цвета — как у приоритетов на странице «Цвета»); точка — кто-то отсутствует.
 */
export default function YearView({ year, tasks, absences = [], onDayClick, onMonthClick }) {
  const today = startOfDay(new Date());

  // Подсчёт задач и отсутствий по дням
  const { counts, absByDay } = useMemo(() => {
    const counts = new Map(); // день → { total, critical, high, normal, low }
    const absByDay = new Map();
    const y0 = new Date(year, 0, 1), y1 = new Date(year + 1, 0, 1);
    for (const t of tasks) {
      if (t.status === 'cancelled') continue;
      let d = startOfDay(t.start_at); if (d < y0) d = y0;
      const end = taskEndDay(t);
      for (let i = 0; d <= end && d < y1 && i < 400; i++, d = addDays(d, 1)) {
        const k = dateKey(d);
        const c = counts.get(k) || { total: 0, critical: 0, high: 0, normal: 0, low: 0 };
        c.total += 1;
        c[t.priority in c ? t.priority : 'normal'] += 1;
        counts.set(k, c);
      }
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
    return { counts, absByDay };
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
                  const c = counts.get(k);
                  const abs = absByDay.get(k) || [];
                  const tip = [fmtDate(d, { weekday: 'short', day: 'numeric', month: 'long' }),
                    c ? `Задач: ${c.total}` : 'Задач нет',
                    ...(c ? PRIO_ORDER.filter((p) => c[p]).map((p) => `  ${PRIORITIES[p].label}: ${c[p]}`) : []),
                    ...abs.map((a) => `${a.user_name} — ${(ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other).label.toLowerCase()}`)].join('\n');
                  return (
                    <button key={i} title={tip} onClick={() => onDayClick(d)}
                      className={`yd ${isWeekend(d) ? 'weekend' : ''} ${sameDay(d, today) ? 'today' : ''} ${c ? 'busy' : ''}`}>
                      <span className="yd-top">
                        <span className="yd-num">{d.getDate()}</span>
                        {abs.length > 0 && <i className="yd-abs" style={{ background: absenceColor(abs[0]) }} />}
                        {c && <b className="yd-total">{num(c.total)}</b>}
                      </span>
                      {c && (
                        <span className="yd-prio">
                          {PRIO_ORDER.filter((p) => c[p]).map((p) => (
                            <span key={p} className="yd-p" style={{ background: PRIORITIES[p].color }}>{num(c[p])}</span>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="legend year-legend">
        <span><b className="yd-total legend-total">5</b> — всего задач в день;</span>
        <span>метки снизу — сколько задач каждого приоритета:</span>
        {PRIO_ORDER.map((p) => <span key={p}><i style={{ background: PRIORITIES[p].color }} />{PRIORITIES[p].label}</span>)}
        <span className="year-legend-sep" />
        <span><i className="yd-abs-legend" />кто-то отсутствует (цвет — вид отсутствия)</span>
      </div>
    </div>
  );
}
