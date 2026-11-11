// Регулярные (периодические) задачи: отчёты и другие дела, которые повторяются каждый месяц, квартал, полгода или год
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { freqLabel, initials, PRIORITIES } from '../constants.js';
import { fmtDate, fmtTime, fromInputDate, sameDay } from '../dates.js';
import Icon from '../components/Icon.jsx';
import TaskModal from '../components/TaskModal.jsx';

// «1 мая — 30 мая», «10-го числа, 09:00–11:00» и т. п. — когда повторяется задача
function when(s) {
  const st = new Date(s.start_at), en = new Date(s.end_at);
  const dm = (d) => fmtDate(d, { day: 'numeric', month: 'long' });
  if (s.every_months === 1) {
    const days = sameDay(st, en) ? `${st.getDate()}-го числа` : `с ${st.getDate()}-го по ${en.getDate()}-е число`;
    return s.all_day ? days : `${days}, ${fmtTime(st)}–${fmtTime(en)}`;
  }
  const base = sameDay(st, en) ? dm(st) : `${dm(st)} — ${dm(en)}`;
  const tail = s.every_months === 12 ? '' : ' (первый раз)';
  return (s.all_day ? base : `${base}, ${fmtTime(st)}–${fmtTime(en)}`) + tail;
}

export default function SeriesPage() {
  const { canEdit, toast } = useApp();
  const [items, setItems] = useState(null);
  const [modal, setModal] = useState(null);

  const load = useCallback(() => api.get('/series').then((d) => setItems(d.series)).catch((e) => toast(e.message, 'err')), [toast]);
  useEffect(() => { load(); }, [load]);

  const remove = async (s) => {
    if (!confirm(`Удалить регулярную задачу «${s.title}»?\nБудущие и невыполненные повторы будут удалены, выполненные сохранятся как обычные задачи.`)) return;
    try { await api.del(`/series/${s.id}`); toast('Регулярная задача удалена'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h2>Регулярные задачи</h2>
          <p className="muted">Отчёты и другие дела, которые повторяются каждый месяц, квартал, полгода или год. Повторы сами появляются в календаре.</p>
        </div>
        {canEdit && (
          <button className="btn primary" onClick={() => {
            const s = new Date(); s.setHours(0, 0, 0, 0);
            setModal({ create: { start: s, end: s, allDay: true, repeat: 'yearly' } });
          }}><Icon name="plus" /> Регулярная задача</button>
        )}
      </header>

      {!items ? <div className="spinner" /> : items.length ? (
        <div className="card flush">
          <table className="table">
            <thead><tr><th>Задача</th><th>Повтор</th><th>Когда</th><th>Ближайший</th><th>Исполнители</th><th>Выполнено</th><th /></tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="person"><i className="dot" style={{ background: s.category_color || '#97A0AF' }} /><b>{s.title}</b></span>
                    <div className="muted small">{s.category_name || 'Без категории'} · <span style={{ color: PRIORITIES[s.priority].color }}>{PRIORITIES[s.priority].label.toLowerCase()} приоритет</span></div>
                  </td>
                  <td>{freqLabel(s.every_months)}{s.until && <div className="muted small">до {fmtDate(fromInputDate(s.until), { day: 'numeric', month: 'short', year: 'numeric' })}</div>}</td>
                  <td>{when(s)}</td>
                  <td>
                    {s.next ? <button className="link" onClick={() => setModal({ id: s.next.id })}>{fmtDate(s.next.start_at, { day: 'numeric', month: 'long', year: 'numeric' })}</button>
                      : <span className="muted">повторов нет</span>}
                    {s.overdue_count > 0 && <div className="danger small">просрочено: {s.overdue_count}</div>}
                  </td>
                  <td>
                    {s.assignees.length ? <span className="avatars">{s.assignees.map((a) => <span key={a.id} className="avatar sm" style={{ background: a.color }} title={a.name}>{initials(a.name)}</span>)}</span>
                      : <span className="muted small">не назначены</span>}
                  </td>
                  <td>{s.done_count}</td>
                  <td className="actions">
                    {canEdit && <button className="icon-btn" title="Изменить все повторы" onClick={() => setModal({ series: s.id })}><Icon name="edit" /></button>}
                    {canEdit && <button className="icon-btn" title="Удалить" onClick={() => remove(s)}><Icon name="trash" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card empty-card">
          <p><b>Регулярных задач пока нет.</b></p>
          <p className="muted">Например, «Отчёт №2» с 1 по 30 мая: создайте задачу на эти даты и в поле «Повторять» выберите «Каждый год» —
            она будет появляться в календаре каждый год в эти же даты.</p>
        </div>
      )}

      {modal && (
        <TaskModal taskId={modal.id} seriesId={modal.series} createDefaults={modal.create}
          onClose={() => setModal(null)} onChanged={load} />
      )}
    </div>
  );
}
