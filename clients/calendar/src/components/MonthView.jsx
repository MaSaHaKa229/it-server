import { useState } from 'react';
import { absenceCoversDay, addDays, dayKey, isWeekend, sameDay, startOfDay, taskCoversDay, WEEKDAYS } from '../dates.js';
import TaskChip from './TaskChip.jsx';
import AbsenceChip from './AbsenceChip.jsx';

// Масштаб: высота ячейки и сколько задач видно без «ещё N»
const ZOOM = [{ h: 84, n: 2 }, { h: 100, n: 3 }, { h: 118, n: 3 }, { h: 168, n: 5 }, { h: 240, n: 8 }];
const MAX_ABS = 2;

export default function MonthView({ cursor, from, tasks, absences = [], zoom = 3, canEdit, onOpen, onOpenAbsence, onCreate, onMove, onDayClick }) {
  const { h: cellH, n: MAX_VISIBLE } = ZOOM[zoom - 1] || ZOOM[2];
  const [dragOver, setDragOver] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const today = startOfDay(new Date());
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));

  const onDrop = (e, day) => {
    e.preventDefault();
    setDragOver(null);
    const id = Number(e.dataTransfer.getData('text/task'));
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    // Сохраняем время суток, меняем только дату
    const s = new Date(task.start_at);
    const target = new Date(day);
    target.setHours(s.getHours(), s.getMinutes(), 0, 0);
    onMove(task, target);
  };

  return (
    <div className="month">
      <div className="month-head">
        {WEEKDAYS.map((w, i) => <div key={w} className={i >= 5 ? 'weekend' : ''}>{w}</div>)}
      </div>
      <div className="month-grid">
        {days.map((day) => {
          const list = tasks
            .filter((t) => taskCoversDay(t, day))
            .sort((a, b) => (b.all_day - a.all_day) || new Date(a.start_at) - new Date(b.start_at));
          const key = dayKey(day);
          const isExpanded = expanded === key;
          const visible = isExpanded ? list : list.slice(0, MAX_VISIBLE);
          const abs = absences.filter((a) => absenceCoversDay(a, day));
          const absVisible = isExpanded ? abs : abs.slice(0, MAX_ABS);
          const hidden = list.length - visible.length + abs.length - absVisible.length;
          return (
            <div
              key={key}
              className={[
                'month-cell',
                day.getMonth() !== cursor.getMonth() && 'other',
                isWeekend(day) && 'weekend',
                sameDay(day, today) && 'today',
                dragOver === key && 'drag-over',
                canEdit && 'editable',
              ].filter(Boolean).join(' ')}
              style={{ minHeight: cellH }}
              onDoubleClick={() => onCreate(day)}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOver(key); } : undefined}
              onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
              onDrop={canEdit ? (e) => onDrop(e, day) : undefined}
            >
              <div className="cell-top">
                <button className="day-num" onClick={() => onDayClick(day)} title="Открыть неделю">{day.getDate()}</button>
                {canEdit && <button className="cell-add" onClick={() => onCreate(day)} title="Добавить задачу">+</button>}
              </div>
              <div className="cell-tasks">
                {visible.map((t) => (
                  <TaskChip key={t.id} task={t} day={day} draggable={canEdit} onClick={() => onOpen(t)} />
                ))}
                {(hidden > 0 || isExpanded) && (list.length > MAX_VISIBLE || abs.length > MAX_ABS) && (
                  <button className="more" onClick={() => setExpanded(isExpanded ? null : key)}>
                    {isExpanded ? 'Свернуть' : `ещё ${hidden}`}
                  </button>
                )}
              </div>
              {/* Отсутствия сотрудников — внизу ячейки */}
              {absVisible.length > 0 && (
                <div className="cell-abs">
                  {absVisible.map((a) => <AbsenceChip key={`a${a.id}`} a={a} onClick={onOpenAbsence} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
