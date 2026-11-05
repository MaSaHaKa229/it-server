import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { fromInputDate, toInputDate, toInputDateTime } from '../dates.js';
import { initials, PRIORITIES, STATUSES } from '../constants.js';
import Icon from './Icon.jsx';

export default function TaskForm({ task, defaults, onSaved, onCancel }) {
  const { users, categories } = useApp();
  const init = task ?? {
    title: '', description: '', status: 'todo', priority: 'normal', category_id: null, assignees: [],
    start_at: defaults?.start ?? new Date(), end_at: defaults?.end ?? new Date(), all_day: defaults?.allDay ?? false,
  };
  const [f, setF] = useState({
    title: init.title,
    description: init.description,
    status: init.status,
    priority: init.priority,
    category_id: init.category_id ?? '',
    assignees: init.assignees.map((a) => a.id ?? a),
    all_day: init.all_day,
    start: init.all_day ? toInputDate(init.start_at) : toInputDateTime(init.start_at),
    end: init.all_day ? toInputDate(init.end_at) : toInputDateTime(init.end_at),
    checklist: task?.checklist?.map(({ text, done }) => ({ text, done })) ?? [],
    repeat: '',
    repeatCount: 4,
  });
  const [newItem, setNewItem] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const toggleAllDay = (allDay) => {
    const parse = (v) => (v.includes('T') ? new Date(v) : fromInputDate(v));
    const s = parse(f.start); const e = parse(f.end);
    if (allDay) setF((x) => ({ ...x, all_day: true, start: toInputDate(s), end: toInputDate(e) }));
    else {
      s.setHours(9, 0); const e2 = new Date(e); e2.setHours(10, 0);
      setF((x) => ({ ...x, all_day: false, start: toInputDateTime(s), end: toInputDateTime(e2) }));
    }
  };

  // При смене начала сдвигаем окончание, сохраняя длительность
  const changeStart = (v) => {
    const parse = (x) => (f.all_day ? fromInputDate(x) : new Date(x));
    const dur = parse(f.end) - parse(f.start);
    const ns = parse(v);
    if (isNaN(ns)) return set('start', v);
    const ne = new Date(ns.getTime() + Math.max(0, dur || 0));
    setF((x) => ({ ...x, start: v, end: f.all_day ? toInputDate(ne) : toInputDateTime(ne) }));
  };

  const toggleAssignee = (id) => set('assignees', f.assignees.includes(id) ? f.assignees.filter((x) => x !== id) : [...f.assignees, id]);

  const addItem = () => {
    if (!newItem.trim()) return;
    set('checklist', [...f.checklist, { text: newItem.trim(), done: false }]);
    setNewItem('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const start = f.all_day ? fromInputDate(f.start) : new Date(f.start);
    const end = f.all_day ? fromInputDate(f.end) : new Date(f.end);
    if (end < start) return setError('Окончание не может быть раньше начала');
    const body = {
      title: f.title, description: f.description, status: f.status, priority: f.priority,
      category_id: f.category_id ? Number(f.category_id) : null, assignees: f.assignees,
      all_day: f.all_day, start_at: start.toISOString(), end_at: end.toISOString(), checklist: f.checklist,
    };
    if (!task && f.repeat) body.repeat = { freq: f.repeat, count: Number(f.repeatCount) };
    setBusy(true);
    try {
      const res = task ? await api.patch(`/tasks/${task.id}`, body) : await api.post('/tasks', body);
      onSaved(res.task, res.tasks?.length ?? 1);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <label className="field">
        <span>Название *</span>
        <input value={f.title} onChange={(e) => set('title', e.target.value)} required autoFocus maxLength={200} placeholder="Что нужно сделать?" />
      </label>

      <div className="form-grid">
        <label className="field">
          <span>Начало</span>
          <input type={f.all_day ? 'date' : 'datetime-local'} value={f.start} onChange={(e) => changeStart(e.target.value)} required />
        </label>
        <label className="field">
          <span>Окончание</span>
          <input type={f.all_day ? 'date' : 'datetime-local'} value={f.end} onChange={(e) => set('end', e.target.value)} required />
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={f.all_day} onChange={(e) => toggleAllDay(e.target.checked)} /> Весь день</label>

      <div className="form-grid three">
        <label className="field">
          <span>Статус</span>
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(STATUSES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Приоритет</span>
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            {Object.entries(PRIORITIES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Категория</span>
          <select value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">Без категории</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="field">
        <span>Исполнители</span>
        <div className="assignee-picker">
          {users.filter((u) => u.is_active || f.assignees.includes(u.id)).map((u) => (
            <button type="button" key={u.id} className={`assignee ${f.assignees.includes(u.id) ? 'on' : ''} ${u.has_access === false ? 'no-access' : ''}`}
              onClick={() => toggleAssignee(u.id)} title={u.has_access === false ? 'Нет доступа к разделу «Задачи» — задачу в календаре не увидит' : ''}>
              <span className="avatar sm" style={{ background: u.color }}>{initials(u.name)}</span>{u.name}
              {u.has_access === false && <small className="no-access-mark">без доступа</small>}
            </button>
          ))}
        </div>
        {users.some((u) => u.has_access === false && f.assignees.includes(u.id)) && (
          <div className="hint">Исполнители с пометкой «без доступа» не видят раздел «Задачи». Сообщите им о задаче или выдайте доступ в «Администрировании».</div>
        )}
      </div>

      <label className="field">
        <span>Описание</span>
        <textarea rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Детали, ссылки, ожидаемый результат" />
      </label>

      <div className="field">
        <span>Чек-лист</span>
        {f.checklist.map((it, i) => (
          <div key={i} className="check-edit">
            <input type="checkbox" checked={it.done} onChange={(e) => set('checklist', f.checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
            <input value={it.text} onChange={(e) => set('checklist', f.checklist.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            <button type="button" className="icon-btn tiny" onClick={() => set('checklist', f.checklist.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
          </div>
        ))}
        <div className="check-edit">
          <Icon name="plus" size={14} />
          <input value={newItem} placeholder="Добавить пункт и нажать Enter" onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} onBlur={addItem} />
        </div>
      </div>

      {!task && (
        <div className="form-grid">
          <label className="field">
            <span>Повторять</span>
            <select value={f.repeat} onChange={(e) => set('repeat', e.target.value)}>
              <option value="">Не повторять</option>
              <option value="daily">Каждый день</option>
              <option value="weekdays">По будням</option>
              <option value="weekly">Каждую неделю</option>
              <option value="monthly">Каждый месяц</option>
            </select>
          </label>
          {f.repeat && (
            <label className="field">
              <span>Количество повторений</span>
              <input type="number" min={2} max={52} value={f.repeatCount} onChange={(e) => set('repeatCount', e.target.value)} />
            </label>
          )}
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Отмена</button>
        <button className="btn primary" disabled={busy}>{busy ? 'Сохранение…' : task ? 'Сохранить' : 'Создать'}</button>
      </div>
    </form>
  );
}
