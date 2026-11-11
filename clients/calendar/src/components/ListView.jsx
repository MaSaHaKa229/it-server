import { dayKey, fmtDate, fmtTime, sameDay, startOfDay } from '../dates.js';
import { isOverdue, PRIORITIES, STATUSES, taskColor } from '../constants.js';
import { initials } from '../constants.js';

/** Исполнители полностью: аватар + ФИО */
function People({ people }) {
  if (!people?.length) return <span className="agenda-who none">Исполнитель не назначен</span>;
  return (
    <span className="agenda-who">
      {people.map((p) => (
        <span key={p.id} className="person"><span className="avatar sm" style={{ background: p.color }}>{initials(p.name)}</span>{p.name}</span>
      ))}
    </span>
  );
}

export default function ListView({ tasks, onOpen, onStatus }) {
  if (!tasks.length) return <div className="empty"><b>Задач за этот период нет</b><div className="muted">Перейдите к другому периоду стрелками вверху, сбросьте фильтры или создайте задачу кнопкой «+ Задача».</div></div>;
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
              <People people={t.assignees} />
              {onStatus && (
                <span className="agenda-quick" onClick={(e) => e.stopPropagation()}>
                  {t.status === 'done' || t.status === 'cancelled'
                    ? <span className="quick-btn" role="button" title="Вернуть в работу" onClick={() => onStatus(t, 'todo')}>↺</span>
                    : <span className="quick-btn" role="button" title="Отметить выполненной" onClick={() => onStatus(t, 'done')}>✓ Выполнено</span>}
                </span>
              )}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
