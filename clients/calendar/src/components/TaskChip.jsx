import { fmtTime, sameDay } from '../dates.js';
import { isOverdue, taskColor } from '../constants.js';

export default function TaskChip({ task: t, day, draggable, onClick }) {
  const startsToday = !day || sameDay(new Date(t.start_at), day);
  const cls = ['chip', `st-${t.status}`, isOverdue(t) && 'overdue', t.priority === 'critical' && 'critical'].filter(Boolean).join(' ');
  return (
    <button
      className={cls}
      style={{ '--c': taskColor(t) }}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData('text/task', String(t.id)); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={t.title}
    >
      {!t.all_day && startsToday && <span className="chip-time">{fmtTime(t.start_at)}</span>}
      {!startsToday && <span className="chip-cont">↳</span>}
      <span className="chip-title">{t.title}</span>
    </button>
  );
}
