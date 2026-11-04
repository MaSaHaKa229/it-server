import { useState } from 'react';
import { addDays, dayKey, isWeekend, sameDay, startOfDay, taskCoversDay, WEEKDAYS } from '../dates.js';
import TaskChip from './TaskChip.jsx';

const MAX_VISIBLE = 3;

export default function MonthView({ cursor, from, tasks, canEdit, onOpen, onCreate, onMove, onDayClick }) {
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
                {list.length > MAX_VISIBLE && (
                  <button className="more" onClick={() => setExpanded(isExpanded ? null : key)}>
                    {isExpanded ? 'Свернуть' : `ещё ${list.length - MAX_VISIBLE}`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
