import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { fmtTaskPeriod, relative } from '../dates.js';
import { freqLabel, initials, isOverdue, PRIORITIES, STATUSES, taskColor } from '../constants.js';
import { fmtDate, fromInputDate } from '../dates.js';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';

const ACTIONS = { create: 'создал(а) задачу', update: 'изменил(а)', comment: 'оставил(а) комментарий' };

/** Удаление повтора регулярной задачи: только этот, этот и следующие, вся серия */
function DeleteSeriesDialog({ task, onPick, onClose }) {
  return (
    <Modal title="Удалить регулярную задачу" onClose={onClose}>
      <p>«{task.title}» повторяется {freqLabel(task.series_every_months).toLowerCase()}. Что удалить?</p>
      <div className="choice-list">
        <button className="choice" onClick={() => onPick('one')}>
          <b>Только этот повтор</b><small>Остальные повторы останутся, этот больше не появится</small>
        </button>
        <button className="choice" onClick={() => onPick('following')}>
          <b>Этот и все следующие</b><small>Повторы прекратятся; выполненные ранее задачи сохранятся</small>
        </button>
        <button className="choice danger-choice" onClick={() => onPick('all')}>
          <b>Все повторы</b><small>Регулярная задача удаляется целиком; выполненные повторы сохранятся как обычные задачи</small>
        </button>
      </div>
      <div className="form-actions"><button className="btn ghost" onClick={onClose}>Отмена</button></div>
    </Modal>
  );
}

export default function TaskModal({ taskId, seriesId, createDefaults, onClose, onChanged }) {
  const { canEdit, user, toast } = useApp();
  const [task, setTask] = useState(null);
  const [editing, setEditing] = useState(!taskId);
  const [series, setSeries] = useState(null); // изменение всех повторов
  const [askDelete, setAskDelete] = useState(false);
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState('comments');

  const load = () => api.get(`/tasks/${taskId}`).then((d) => setTask(d.task)).catch((e) => { toast(e.message, 'err'); onClose(); });
  useEffect(() => { if (taskId) load(); }, [taskId]);
  const editSeries = (id) => api.get(`/series/${id}`).then((d) => setSeries(d.series)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (seriesId) editSeries(seriesId); }, [seriesId]);

  if (seriesId && !series) return <Modal title="Регулярная задача" onClose={onClose}><div className="spinner" /></Modal>;
  if (series) {
    const close = seriesId ? onClose : () => setSeries(null);
    return (
      <Modal title="Изменение всех повторов" onClose={close} wide>
        <TaskForm series={series} onCancel={close}
          onSaved={() => { toast('Регулярная задача сохранена'); onChanged(); if (seriesId) onClose(); else { setSeries(null); load(); } }} />
      </Modal>
    );
  }

  if (editing) {
    return (
      <Modal title={taskId ? 'Редактирование задачи' : 'Новая задача'} onClose={taskId ? () => setEditing(false) : onClose} wide>
        <TaskForm
          task={task}
          defaults={createDefaults}
          onCancel={taskId ? () => setEditing(false) : onClose}
          onSaved={(t, count, res) => {
            toast(taskId ? 'Задача сохранена' : res?.series_id
              ? (t ? `Регулярная задача создана, ближайший повтор — ${fmtDate(t.start_at, { day: 'numeric', month: 'long', year: 'numeric' })}` : 'Регулярная задача создана')
              : count > 1 ? `Создано задач: ${count}` : 'Задача создана');
            onChanged();
            if (taskId) { setEditing(false); load(); } else onClose();
          }}
        />
      </Modal>
    );
  }

  if (!task) return <Modal title="Задача" onClose={onClose}><div className="spinner" /></Modal>;

  const act = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg); onChanged(); } catch (e) { toast(e.message, 'err'); }
  };
  const setStatus = (status) => act(async () => { await api.patch(`/tasks/${task.id}`, { status }); await load(); }, 'Статус обновлён');
  const remove = (scope) => {
    if (task.series_id && !scope) return setAskDelete(true);
    if (!task.series_id && !confirm(`Удалить задачу «${task.title}»?`)) return;
    const msg = { one: 'Повтор удалён', following: 'Повторы прекращены', all: 'Регулярная задача удалена' }[scope] || 'Задача удалена';
    act(async () => { await api.del(`/tasks/${task.id}${scope ? `?scope=${scope}` : ''}`); onClose(); }, msg);
  };
  if (askDelete) return <DeleteSeriesDialog task={task} onClose={() => setAskDelete(false)} onPick={(sc) => { setAskDelete(false); remove(sc); }} />;
  const duplicate = () => act(async () => { await api.post(`/tasks/${task.id}/duplicate`); onClose(); }, 'Создана копия задачи');
  const toggleItem = (it) => act(async () => { await api.patch(`/tasks/${task.id}/checklist/${it.id}`, { done: !it.done }); await load(); });
  const sendComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    await act(async () => { await api.post(`/tasks/${task.id}/comments`, { body: comment }); setComment(''); await load(); });
  };
  const delComment = (c) => act(async () => { await api.del(`/tasks/${task.id}/comments/${c.id}`); await load(); });

  const overdue = isOverdue(task);
  const progress = task.checklist.length ? Math.round((task.checklist.filter((i) => i.done).length / task.checklist.length) * 100) : 0;

  return (
    <Modal onClose={onClose} wide
      title={<span className="modal-title-row"><span className="dot lg" style={{ background: taskColor(task) }} />{task.title}</span>}
      actions={canEdit && (
        <>
          <button className="icon-btn" title="Копировать" onClick={duplicate}><Icon name="copy" /></button>
          <button className="icon-btn" title="Удалить" onClick={() => remove()}><Icon name="trash" /></button>
          <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" /> Изменить</button>
        </>
      )}>
      <div className="task-view">
        <div className="task-meta">
          <div className="meta-row"><span>Когда</span><b className={overdue ? 'danger' : ''}>{fmtTaskPeriod(task)}{overdue && ' · просрочено'}</b></div>
          <div className="meta-row">
            <span>Статус</span>
            {canEdit ? (
              <select className="inline-select" value={task.status} onChange={(e) => setStatus(e.target.value)} style={{ '--p': STATUSES[task.status].color }}>
                {Object.entries(STATUSES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
            ) : <span className="pill" style={{ '--p': STATUSES[task.status].color }}>{STATUSES[task.status].label}</span>}
          </div>
          <div className="meta-row"><span>Приоритет</span><span className="pill" style={{ '--p': PRIORITIES[task.priority].color }}>{PRIORITIES[task.priority].label}</span></div>
          <div className="meta-row"><span>Категория</span><b>{task.category_name || '—'}</b></div>
          {task.series_id && (
            <div className="meta-row">
              <span>Повтор</span>
              <span className="series-meta">
                <b>{freqLabel(task.series_every_months)}</b>
                {task.series_until && <span className="muted"> · до {fmtDate(fromInputDate(task.series_until), { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
                {canEdit && <button className="link" onClick={() => editSeries(task.series_id)}>Изменить все повторы</button>}
              </span>
            </div>
          )}
          <div className="meta-row">
            <span>Исполнители</span>
            <div className="people">
              {task.assignees.length ? task.assignees.map((a) => (
                <span key={a.id} className="person"><span className="avatar sm" style={{ background: a.color }}>{initials(a.name)}</span>{a.name}</span>
              )) : <span className="muted">не назначены</span>}
            </div>
          </div>
        </div>

        {task.helpdesk_ticket_id && (
          <div className="helpdesk-note">
            <a href={`/helpdesk/#/tickets/${task.helpdesk_ticket_id}`}>Открыть заявку #{task.helpdesk_ticket_id} в helpdesk →</a>
            <div className="muted">Задача создана из заявки. Срок, исполнитель, приоритет и статус меняются в заявке — здесь они обновятся сами.</div>
          </div>
        )}
        {task.description && <div className="task-desc">{task.description}</div>}

        {task.checklist.length > 0 && (
          <div className="checklist">
            <div className="checklist-head"><b>Чек-лист</b><span className="muted">{progress}%</span></div>
            <div className="progress"><div style={{ width: `${progress}%` }} /></div>
            {task.checklist.map((it) => (
              <label key={it.id} className={`check-item ${it.done ? 'done' : ''}`}>
                <input type="checkbox" checked={it.done} disabled={!canEdit} onChange={() => toggleItem(it)} />
                <span>{it.text}</span>
              </label>
            ))}
          </div>
        )}

        <div className="tabs">
          <button className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>Комментарии ({task.comments.length})</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>История</button>
        </div>

        {tab === 'comments' && (
          <div className="comments">
            {task.comments.map((c) => (
              <div key={c.id} className="comment">
                <span className="avatar sm" style={{ background: c.user_color || '#94a3b8' }}>{initials(c.user_name || '?')}</span>
                <div>
                  <div className="comment-head">
                    <b>{c.user_name || 'Удалённый пользователь'}</b><small>{relative(c.created_at)}</small>
                    {canEdit && (c.user_id === user.id || user.role === 'admin') && (
                      <button className="link danger small" onClick={() => delComment(c)}>удалить</button>
                    )}
                  </div>
                  <div className="comment-body">{c.body}</div>
                </div>
              </div>
            ))}
            {!task.comments.length && <p className="muted small">Комментариев пока нет</p>}
            {canEdit && (
              <form className="comment-form" onSubmit={sendComment}>
                <textarea rows={2} placeholder="Написать комментарий…" value={comment} onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendComment(e); }} />
                <button className="btn primary" disabled={!comment.trim()}>Отправить</button>
              </form>
            )}
          </div>
        )}

        {tab === 'history' && (
          <ul className="history">
            {task.history.map((h, i) => (
              <li key={i}>
                <b>{h.user_name || 'Система'}</b> {ACTIONS[h.action] || h.action}
                {h.details?.fields && `: ${h.details.fields.join(', ')}`}
                {h.details?.status && ` → «${STATUSES[h.details.status]?.label}»`}
                <small>{relative(h.created_at)}</small>
              </li>
            ))}
          </ul>
        )}

        <p className="muted small">
          Создал(а): {task.created_by_name || '—'}
          {task.updated_by_name && ` · Изменено ${relative(task.updated_at)} (${task.updated_by_name})`}
        </p>
      </div>
    </Modal>
  );
}
