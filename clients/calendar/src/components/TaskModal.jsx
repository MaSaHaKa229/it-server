import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { fmtTaskPeriod, relative } from '../dates.js';
import { initials, isOverdue, PRIORITIES, STATUSES } from '../constants.js';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';

const ACTIONS = { create: 'создал(а) задачу', update: 'изменил(а)', comment: 'оставил(а) комментарий' };

export default function TaskModal({ taskId, createDefaults, onClose, onChanged }) {
  const { canEdit, user, toast } = useApp();
  const [task, setTask] = useState(null);
  const [editing, setEditing] = useState(!taskId);
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState('comments');

  const load = () => api.get(`/tasks/${taskId}`).then((d) => setTask(d.task)).catch((e) => { toast(e.message, 'err'); onClose(); });
  useEffect(() => { if (taskId) load(); }, [taskId]);

  if (editing) {
    return (
      <Modal title={taskId ? 'Редактирование задачи' : 'Новая задача'} onClose={taskId ? () => setEditing(false) : onClose} wide>
        <TaskForm
          task={task}
          defaults={createDefaults}
          onCancel={taskId ? () => setEditing(false) : onClose}
          onSaved={(t, count) => {
            toast(taskId ? 'Задача сохранена' : count > 1 ? `Создано задач: ${count}` : 'Задача создана');
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
  const remove = () => {
    if (!confirm(`Удалить задачу «${task.title}»?`)) return;
    act(async () => { await api.del(`/tasks/${task.id}`); onClose(); }, 'Задача удалена');
  };
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
      title={<span className="modal-title-row"><span className="dot lg" style={{ background: task.category_color || '#64748b' }} />{task.title}</span>}
      actions={canEdit && (
        <>
          <button className="icon-btn" title="Копировать" onClick={duplicate}><Icon name="copy" /></button>
          <button className="icon-btn" title="Удалить" onClick={remove}><Icon name="trash" /></button>
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
          <div className="meta-row">
            <span>Исполнители</span>
            <div className="people">
              {task.assignees.length ? task.assignees.map((a) => (
                <span key={a.id} className="person"><span className="avatar sm" style={{ background: a.color }}>{initials(a.name)}</span>{a.name}</span>
              )) : <span className="muted">не назначены</span>}
            </div>
          </div>
        </div>

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
