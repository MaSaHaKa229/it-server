import { dayKey, fmtDate, fmtTime, sameDay, startOfDay } from '../dates.js';
import { isOverdue, PRIORITIES, STATUSES, taskColor } from '../constants.js';
import Avatars from './Avatars.jsx';

export default function ListView({ tasks, onOpen }) {
  if (!tasks.length) return <div className="empty">Задач за этот период нет</div>;
  const groups = new Map();
  for (const t of tasks) {
    const k = dayKey(startOfDay(t.start_at));
    if (!groups.has(k)) groups.set(k, { day: startOfDay(t.start_at), items: [] });
    groups.get(k).items.push(t);
  }
  const today = new Date();
  return (
    <div className="agenda">
      {[...groups.values()].map(({ day, items }) => (
        <section key={dayKey(day)} className="agenda-day">
          <h3 className={sameDay(day, today) ? 'today' : ''}>
            {fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}
            {sameDay(day, today) && <span className="badge">Сегодня</span>}
          </h3>
          {items.map((t) => (
            <button key={t.id} className="agenda-row" onClick={() => onOpen(t)} style={{ '--c': taskColor(t) }}>
              <span className="agenda-time">{t.all_day ? 'весь день' : `${fmtTime(t.start_at)}–${fmtTime(t.end_at)}`}</span>
              <span className="agenda-main">
                <b className={t.status === 'done' || t.status === 'cancelled' ? 'strike' : ''}>{t.title}</b>
                <small>
                  {t.category_name && <span className="dot" style={{ background: t.category_color }} />}
                  {t.category_name || 'Без категории'}
                  {t.checklist_total > 0 && ` · ✓ ${t.checklist_done}/${t.checklist_total}`}
                  {t.comment_count > 0 && ` · 💬 ${t.comment_count}`}
                </small>
              </span>
              <span className="pill" style={{ '--p': PRIORITIES[t.priority].color }}>{PRIORITIES[t.priority].label}</span>
              <span className="pill" style={{ '--p': isOverdue(t) ? '#dc2626' : STATUSES[t.status].color }}>
                {isOverdue(t) ? 'Просрочено' : STATUSES[t.status].label}
              </span>
              <Avatars people={t.assignees} />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
