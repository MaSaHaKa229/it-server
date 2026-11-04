import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import {
  addDays, addMonths, fmtDate, fmtMonthYear, startOfDay, startOfMonth, startOfWeek,
} from '../dates.js';
import { PRIORITIES, STATUSES } from '../constants.js';
import Icon from '../components/Icon.jsx';
import MonthView from '../components/MonthView.jsx';
import WeekView from '../components/WeekView.jsx';
import ListView from '../components/ListView.jsx';
import TaskModal from '../components/TaskModal.jsx';

const VIEWS = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'list', label: 'Список' },
];

function rangeFor(view, cursor) {
  if (view === 'week') { const from = startOfWeek(cursor); return { from, to: addDays(from, 7) }; }
  if (view === 'list') { const from = startOfMonth(cursor); return { from, to: addMonths(from, 1) }; }
  const from = startOfWeek(startOfMonth(cursor));
  return { from, to: addDays(from, 42) };
}

const loadPref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

export default function CalendarPage() {
  const { canEdit, users, categories, toast } = useApp();
  const [view, setView] = useState(() => loadPref('cal.view', 'month'));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [filters, setFilters] = useState(() => loadPref('cal.filters', { assignee: '', category: '', status: '', priority: '', mine: false, hideDone: false }));
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // { id } | { create: {start, end, allDay} }

  useEffect(() => localStorage.setItem('cal.view', JSON.stringify(view)), [view]);
  useEffect(() => localStorage.setItem('cal.filters', JSON.stringify(filters)), [filters]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const query = useMemo(() => ({
    from: range.from, to: range.to, q: debounced,
    assignee: filters.assignee, category: filters.category, priority: filters.priority,
    status: filters.status || (filters.hideDone ? 'todo,in_progress' : ''),
    mine: filters.mine ? '1' : '',
  }), [range, debounced, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { tasks } = await api.get('/tasks' + qs(query));
      setTasks(tasks);
    } catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
  }, [query, toast]);

  useEffect(() => { load(); }, [load]);

  const step = (dir) => setCursor((c) => (view === 'week' ? addDays(c, 7 * dir) : addMonths(c, dir)));
  const title = view === 'week'
    ? `${fmtDate(range.from, { day: 'numeric', month: 'short' })} — ${fmtDate(addDays(range.to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`
    : fmtMonthYear(cursor);

  const openCreate = (start, allDay = true, end) => {
    if (!canEdit) return;
    const s = new Date(start);
    const e = end ? new Date(end) : allDay ? new Date(s) : new Date(s.getTime() + 3600e3);
    setModal({ create: { start: s, end: e, allDay } });
  };

  // Перетаскивание задачи: сдвигаем начало и конец на одинаковую величину
  const moveTask = async (task, newStart) => {
    const oldStart = new Date(task.start_at);
    const delta = newStart.getTime() - oldStart.getTime();
    if (!delta) return;
    const optimistic = { ...task, start_at: newStart.toISOString(), end_at: new Date(new Date(task.end_at).getTime() + delta).toISOString() };
    setTasks((ts) => ts.map((t) => (t.id === task.id ? optimistic : t)));
    try {
      await api.patch(`/tasks/${task.id}`, { start_at: optimistic.start_at, end_at: optimistic.end_at });
      toast(`«${task.title}» перенесена на ${fmtDate(newStart)}`);
    } catch (e) {
      toast(e.message, 'err');
    }
    load();
  };

  const activeFilters = ['assignee', 'category', 'status', 'priority'].filter((k) => filters[k]).length + (filters.mine ? 1 : 0) + (filters.hideDone ? 1 : 0);
  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="page calendar-page">
      <header className="toolbar">
        <div className="toolbar-left">
          <button className="btn" onClick={() => setCursor(startOfDay(new Date()))}>Сегодня</button>
          <div className="btn-group">
            <button className="icon-btn" onClick={() => step(-1)} aria-label="Назад"><Icon name="left" /></button>
            <button className="icon-btn" onClick={() => step(1)} aria-label="Вперёд"><Icon name="right" /></button>
          </div>
          <h2 className="toolbar-title">{title}</h2>
          {loading && <div className="spinner small" />}
        </div>
        <div className="toolbar-right">
          <div className="segmented">
            {VIEWS.map((v) => (
              <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>{v.label}</button>
            ))}
          </div>
          <a className="icon-btn" href={'/calendar/api/tasks/export.ics' + qs(query)} title="Экспорт в .ics (Outlook, Google Календарь)">
            <Icon name="download" />
          </a>
          {canEdit && (
            <button className="btn primary" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); openCreate(s, false); }}>
              <Icon name="plus" /> Задача
            </button>
          )}
        </div>
      </header>

      <div className="filters">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Поиск по задачам" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="icon-btn tiny" onClick={() => setSearch('')}><Icon name="x" size={14} /></button>}
        </div>
        <select value={filters.assignee} onChange={(e) => setF('assignee', e.target.value)}>
          <option value="">Все исполнители</option>
          {users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => setF('category', e.target.value)}>
          <option value="">Все категории</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setF('status', e.target.value)}>
          <option value="">Любой статус</option>
          {Object.entries(STATUSES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setF('priority', e.target.value)}>
          <option value="">Любой приоритет</option>
          {Object.entries(PRIORITIES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={filters.mine} onChange={(e) => setF('mine', e.target.checked)} /> Мои задачи</label>
        <label className="check"><input type="checkbox" checked={filters.hideDone} onChange={(e) => setF('hideDone', e.target.checked)} /> Скрыть завершённые</label>
        {activeFilters > 0 && (
          <button className="btn ghost small" onClick={() => setFilters({ assignee: '', category: '', status: '', priority: '', mine: false, hideDone: false })}>
            Сбросить ({activeFilters})
          </button>
        )}
      </div>

      <div className="calendar-body">
        {view === 'month' && (
          <MonthView cursor={cursor} from={range.from} tasks={tasks} canEdit={canEdit}
            onOpen={(t) => setModal({ id: t.id })} onCreate={(d) => openCreate(d, true)} onMove={moveTask}
            onDayClick={(d) => { setCursor(d); setView('week'); }} />
        )}
        {view === 'week' && (
          <WeekView from={range.from} tasks={tasks} canEdit={canEdit}
            onOpen={(t) => setModal({ id: t.id })} onCreate={openCreate} onMove={moveTask} />
        )}
        {view === 'list' && <ListView tasks={tasks} onOpen={(t) => setModal({ id: t.id })} />}
      </div>

      {!canEdit && <div className="readonly-note"><Icon name="eye" size={14} /> Режим просмотра: изменения недоступны</div>}

      {modal && (
        <TaskModal
          taskId={modal.id}
          createDefaults={modal.create}
          onClose={() => setModal(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
