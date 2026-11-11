import { useEffect, useRef, useState } from 'react';
import { absenceCoversDay, addDays, fmtDate, fmtTime, isWeekend, sameDay, startOfDay, taskCoversDay, taskEndDay, WEEKDAYS } from '../dates.js';
import { isOverdue, taskColor, whoShort, whoFull } from '../constants.js';
import TaskChip from './TaskChip.jsx';
import AbsenceChip from './AbsenceChip.jsx';

// Масштаб: высота часа в пикселях
const HOURS = [24, 36, 48, 72, 96];

// Раскладка пересекающихся задач по колонкам внутри дня
function layout(items) {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.height - a.height);
  const cols = [];
  const groups = [];
  let group = [];
  let groupEnd = -1;
  for (const it of sorted) {
    if (it.top >= groupEnd && group.length) { groups.push(group); group = []; cols.length = 0; }
    let col = cols.findIndex((end) => end <= it.top);
    if (col === -1) { col = cols.length; cols.push(0); }
    cols[col] = it.top + it.height;
    it.col = col;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.top + it.height);
  }
  if (group.length) groups.push(group);
  for (const g of groups) {
    const n = Math.max(...g.map((i) => i.col)) + 1;
    g.forEach((i) => { i.cols = n; });
  }
  return sorted;
}

/** Неделя (count = 7) или день (count = 1) с сеткой по часам */
export default function WeekView({ from, count = 7, tasks, absences = [], zoom = 3, canEdit, onOpen, onOpenAbsence, onCreate, onMove, onDayClick }) {
  const HOUR = HOURS[zoom - 1] || 48;
  const cols = { gridTemplateColumns: `58px repeat(${count}, minmax(0, 1fr))` };
  const scroller = useRef(null);
  const [now, setNow] = useState(new Date());
  const [dragOver, setDragOver] = useState(null);
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = HOUR * 8 - 8; }, [HOUR]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);

  const isAllDayRow = (t) => t.all_day || !sameDay(startOfDay(t.start_at), taskEndDay(t));
  const topRow = tasks.filter(isAllDayRow);

  const slotTime = (e, day) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.max(0, Math.min(24 * 60 - 30, Math.floor(((e.clientY - rect.top) / HOUR) * 2) * 30));
    const d = new Date(day);
    d.setHours(0, minutes, 0, 0);
    return d;
  };

  const onDrop = (e, day) => {
    e.preventDefault();
    setDragOver(null);
    const task = tasks.find((t) => t.id === Number(e.dataTransfer.getData('text/task')));
    if (!task) return;
    if (isAllDayRow(task)) {
      const s = new Date(task.start_at); const target = new Date(day); target.setHours(s.getHours(), s.getMinutes(), 0, 0);
      onMove(task, target);
    } else {
      onMove(task, slotTime(e, day));
    }
  };

  return (
    <div className={`week ${count === 1 ? 'day-view' : ''}`} style={{ '--hour': `${HOUR}px` }}>
      <div className="week-head" style={cols}>
        <div className="gutter" />
        {days.map((d) => (
          <div key={d} className={`week-day-head ${sameDay(d, now) ? 'today' : ''} ${isWeekend(d) ? 'weekend' : ''} ${onDayClick ? 'clickable' : ''}`}
            onClick={onDayClick ? () => onDayClick(d) : undefined} title={onDayClick ? 'Открыть день' : undefined}>
            <span>{count === 1 ? fmtDate(d, { weekday: 'long' }) : WEEKDAYS[(d.getDay() + 6) % 7]}</span>
            <b>{count === 1 ? fmtDate(d, { day: 'numeric', month: 'long' }) : d.getDate()}</b>
          </div>
        ))}
      </div>
      <div className="week-allday" style={cols}>
        <div className="gutter small">весь день</div>
        {days.map((d) => (
          <div key={d} className="allday-cell"
            onDoubleClick={() => onCreate(d, true)}
            onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
            onDrop={canEdit ? (e) => onDrop(e, d) : undefined}>
            {absences.filter((a) => absenceCoversDay(a, d)).map((a) => <AbsenceChip key={`a${a.id}`} a={a} onClick={onOpenAbsence} />)}
            {topRow.filter((t) => taskCoversDay(t, d)).map((t) => (
              <TaskChip key={t.id} task={t} day={d} draggable={canEdit} onClick={() => onOpen(t)} />
            ))}
          </div>
        ))}
      </div>
      <div className="week-scroll" ref={scroller}>
        <div className="week-grid" style={{ height: HOUR * 24, ...cols }}>
          <div className="gutter hours">
            {Array.from({ length: 24 }, (_, h) => <div key={h} style={{ height: HOUR }}><span>{h ? `${String(h).padStart(2, '0')}:00` : ''}</span></div>)}
          </div>
          {days.map((d) => {
            const items = layout(tasks
              .filter((t) => !isAllDayRow(t) && sameDay(new Date(t.start_at), d))
              .map((t) => {
                const s = new Date(t.start_at), e = new Date(t.end_at);
                const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * HOUR;
                const height = Math.max(22, ((e - s) / 3600e3) * HOUR);
                return { t, top, height };
              }));
            const key = d.toDateString();
            return (
              <div key={key}
                className={`week-col ${isWeekend(d) ? 'weekend' : ''} ${dragOver === key ? 'drag-over' : ''} ${canEdit ? 'editable' : ''}`}
                onClick={(e) => canEdit && e.target === e.currentTarget && onCreate(slotTime(e, d), false)}
                onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOver(key); } : undefined}
                onDragLeave={() => setDragOver(null)}
                onDrop={canEdit ? (e) => onDrop(e, d) : undefined}>
                {sameDay(d, now) && <div className="now-line" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR }} />}
                {items.map(({ t, top, height, col, cols }) => (
                  <button key={t.id}
                    className={`event st-${t.status} ${isOverdue(t) ? 'overdue' : ''}`}
                    style={{ top, height, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`, '--c': taskColor(t) }}
                    draggable={canEdit}
                    onDragStart={(e) => e.dataTransfer.setData('text/task', String(t.id))}
                    onClick={() => onOpen(t)}
                    title={`${t.title}\n${fmtTime(t.start_at)}–${fmtTime(t.end_at)}\nИсполнитель: ${whoFull(t.assignees)}`}>
                    <b>{t.title}</b>
                    <span className={`event-who ${t.assignees.length ? '' : 'none'}`}>{whoShort(t.assignees)}</span>
                    {height >= HOUR * 1.4 && <span>{fmtTime(t.start_at)}–{fmtTime(t.end_at)}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
