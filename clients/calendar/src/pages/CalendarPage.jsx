import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import {
  addDays, addMonths, dateKey, fmtDate, fmtMonthYear, fromInputDate, startOfDay, startOfMonth, startOfWeek,
} from '../dates.js';
import { PRIORITIES, SOURCES, STATUSES } from '../constants.js';
import Icon from '../components/Icon.jsx';
import MonthView from '../components/MonthView.jsx';
import WeekView from '../components/WeekView.jsx';
import YearView from '../components/YearView.jsx';
import ListView from '../components/ListView.jsx';
import TaskModal from '../components/TaskModal.jsx';
import AbsenceModal from '../components/AbsenceModal.jsx';
import MultiSelect from '../components/MultiSelect.jsx';

const VIEWS = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'list', label: 'Список' },
];
const ZOOM_LABELS = ['Мелко', 'Компактно', 'Обычно', 'Крупно', 'Очень крупно'];

function rangeFor(view, cursor) {
  if (view === 'day') { const from = startOfDay(cursor); return { from, to: addDays(from, 1) }; }
  if (view === 'week') { const from = startOfWeek(cursor); return { from, to: addDays(from, 7) }; }
  if (view === 'list') { const from = startOfMonth(cursor); return { from, to: addMonths(from, 1) }; }
  if (view === 'year') { const from = new Date(cursor.getFullYear(), 0, 1); return { from, to: new Date(cursor.getFullYear() + 1, 0, 1) }; }
  const from = startOfWeek(startOfMonth(cursor));
  return { from, to: addDays(from, 42) };
}

const loadPref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* нет места */ } };

const EMPTY = {
  assignee: [], category: [], status: [], priority: [], source: [], author: [],
  mine: false, overdue: false, hideDone: false, showAbsences: true,
};
const LIST_KEYS = ['assignee', 'category', 'status', 'priority', 'source', 'author'];
// Фильтры прежней версии хранились строками — приводим к спискам
function normalize(f) {
  const out = { ...EMPTY, ...f };
  for (const k of LIST_KEYS) {
    const v = out[k];
    out[k] = Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
  }
  return out;
}

export default function CalendarPage() {
  const { canEdit, user, users, categories, toast } = useApp();
  const [view, setView] = useState(() => { const v = loadPref('cal.view', 'month'); return VIEWS.some((x) => x.id === v) ? v : 'month'; });
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [zoom, setZoom] = useState(() => Math.min(5, Math.max(1, Number(loadPref('cal.zoom', 3)) || 3)));
  const [filters, setFilters] = useState(() => normalize(loadPref('cal.filters', {})));
  const [showFilters, setShowFilters] = useState(() => loadPref('cal.showFilters', false));
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tasks, setTasks] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // { id } | { create } | { absence } | { newAbsence }

  // Ссылки: #/calendar?task=12 — открыть задачу; ?date=2026-05-01&view=day — перейти к дате
  useEffect(() => {
    const open = () => {
      const p = new URLSearchParams(window.location.hash.split('?')[1] || '');
      const id = Number(p.get('task'));
      if (id) setModal({ id });
      if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '')) setCursor(fromInputDate(p.get('date')));
      if (VIEWS.some((v) => v.id === p.get('view'))) setView(p.get('view'));
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  useEffect(() => savePref('cal.view', view), [view]);
  useEffect(() => savePref('cal.zoom', zoom), [zoom]);
  useEffect(() => savePref('cal.filters', filters), [filters]);
  useEffect(() => savePref('cal.showFilters', showFilters), [showFilters]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const query = useMemo(() => ({
    from: range.from, to: range.to, q: debounced,
    assignee: filters.assignee, category: filters.category, priority: filters.priority,
    source: filters.source, author: filters.author,
    status: filters.status.length ? filters.status : (filters.hideDone ? ['todo', 'in_progress'] : []),
    mine: filters.mine ? '1' : '', overdue: filters.overdue ? '1' : '',
    limit: view === 'year' ? 5000 : '',
  }), [range, debounced, filters, view]);

  // Чьи отсутствия показывать: «мои задачи» — только свои; выбраны исполнители — только их
  const absQuery = useMemo(() => {
    if (!filters.showAbsences || view === 'list') return null;
    const ids = filters.mine ? [String(user.id)] : filters.assignee.filter((x) => x !== 'none');
    if (!filters.mine && filters.assignee.length && !ids.length) return null;
    return { from: dateKey(range.from), to: dateKey(range.to), user: ids };
  }, [filters.showAbsences, filters.mine, filters.assignee, range, view, user.id]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([
        api.get('/tasks' + qs(query)),
        absQuery ? api.get('/absences' + qs(absQuery)) : Promise.resolve({ absences: [] }),
      ]);
      setTasks(t.tasks);
      setAbsences(a.absences);
    } catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
  }, [query, absQuery, toast]);

  useEffect(() => { load(); }, [load]);

  const step = (dir) => setCursor((c) => ({
    day: addDays(c, dir), week: addDays(c, 7 * dir), year: new Date(c.getFullYear() + dir, c.getMonth(), 1),
  }[view] ?? addMonths(c, dir)));
  const title = {
    day: fmtDate(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    week: `${fmtDate(range.from, { day: 'numeric', month: 'short' })} — ${fmtDate(addDays(range.to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`,
    year: `${cursor.getFullYear()} год`,
  }[view] ?? fmtMonthYear(cursor);

  const openCreate = (start, allDay = true, end) => {
    if (!canEdit) return;
    const s = new Date(start);
    const e = end ? new Date(end) : allDay ? new Date(s) : new Date(s.getTime() + 3600e3);
    setModal({ create: { start: s, end: e, allDay } });
  };
  const goDay = (d) => { setCursor(startOfDay(d)); setView('day'); };

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

  const activeFilters = LIST_KEYS.filter((k) => filters[k].length).length
    + ['mine', 'overdue', 'hideDone'].filter((k) => filters[k]).length + (filters.showAbsences ? 0 : 1);
  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const zoomable = ['day', 'week', 'month'].includes(view);

  const people = users.filter((u) => u.is_active);
  const userOpts = people.map((u) => ({ value: String(u.id), label: u.name, color: u.color }));

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
          <div className="zoom" title={zoomable ? 'Масштаб календаря' : 'Масштаб меняется в видах «День», «Неделя» и «Месяц»'}>
            <button className="icon-btn" disabled={!zoomable || zoom <= 1} onClick={() => setZoom((z) => z - 1)} aria-label="Мельче">−</button>
            <span className="zoom-label">{zoomable ? ZOOM_LABELS[zoom - 1] : 'Масштаб'}</span>
            <button className="icon-btn" disabled={!zoomable || zoom >= 5} onClick={() => setZoom((z) => z + 1)} aria-label="Крупнее">+</button>
          </div>
          <div className="segmented">
            {VIEWS.map((v) => (
              <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>{v.label}</button>
            ))}
          </div>
          <a className="icon-btn" href={'/calendar/api/tasks/export.ics' + qs({ ...query, limit: '' })} title="Экспорт в .ics (Outlook, Google Календарь)">
            <Icon name="download" />
          </a>
          {canEdit && (
            <button className="btn" onClick={() => setModal({ newAbsence: { start_date: dateKey(view === 'month' || view === 'year' ? new Date() : cursor) } })}
              title="Отметить отпуск, больничный, командировку или отгул">
              <Icon name="users" size={16} /> Отсутствие
            </button>
          )}
          {canEdit && (
            <button className="btn primary" onClick={() => { const s = view === 'day' ? new Date(cursor) : new Date(); if (view === 'day') s.setHours(9); else s.setHours(s.getHours() + 1); s.setMinutes(0, 0, 0); openCreate(s, false); }}>
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
        <MultiSelect label="Исполнители" allLabel="Все исполнители" searchable value={filters.assignee} onChange={(v) => setF('assignee', v)}
          options={[{ value: 'none', label: 'Без исполнителя', divider: true }, ...userOpts]} />
        <MultiSelect label="Категории" allLabel="Все категории" value={filters.category} onChange={(v) => setF('category', v)}
          options={[...categories.map((c) => ({ value: String(c.id), label: c.name, color: c.color })), { value: 'none', label: 'Без категории' }]} />
        <MultiSelect label="Статусы" allLabel="Любой статус" value={filters.status} onChange={(v) => setF('status', v)}
          options={Object.entries(STATUSES).map(([k, s]) => ({ value: k, label: s.label, color: s.color }))} />
        <label className="check"><input type="checkbox" checked={filters.mine} onChange={(e) => setF('mine', e.target.checked)} /> Мои задачи</label>
        <label className="check"><input type="checkbox" checked={filters.hideDone} onChange={(e) => setF('hideDone', e.target.checked)} /> Скрыть завершённые</label>
        <button className={`btn ghost small ${showFilters ? 'active-toggle' : ''}`} onClick={() => setShowFilters((x) => !x)}>
          <Icon name="filter" size={14} /> {showFilters ? 'Меньше фильтров' : 'Ещё фильтры'}
        </button>
        {activeFilters > 0 && (
          <button className="btn ghost small" onClick={() => setFilters(EMPTY)}>Сбросить ({activeFilters})</button>
        )}
      </div>
      {showFilters && (
        <div className="filters more-filters">
          <MultiSelect label="Приоритеты" allLabel="Любой приоритет" value={filters.priority} onChange={(v) => setF('priority', v)}
            options={Object.entries(PRIORITIES).map(([k, s]) => ({ value: k, label: s.label, color: s.color }))} />
          <MultiSelect label="Вид" allLabel="Все виды задач" value={filters.source} onChange={(v) => setF('source', v)}
            options={Object.entries(SOURCES).map(([k, l]) => ({ value: k, label: l }))} />
          <MultiSelect label="Авторы" allLabel="Любой автор" searchable value={filters.author} onChange={(v) => setF('author', v)} options={userOpts} />
          <label className="check"><input type="checkbox" checked={filters.overdue} onChange={(e) => setF('overdue', e.target.checked)} /> Только просроченные</label>
          <label className="check"><input type="checkbox" checked={filters.showAbsences} onChange={(e) => setF('showAbsences', e.target.checked)} /> Показывать отпуска и отсутствия</label>
        </div>
      )}

      <div className="calendar-body">
        {view === 'month' && (
          <MonthView cursor={cursor} from={range.from} tasks={tasks} absences={absences} zoom={zoom} canEdit={canEdit}
            onOpen={(t) => setModal({ id: t.id })} onOpenAbsence={(a) => setModal({ absence: a })}
            onCreate={(d) => openCreate(d, true)} onMove={moveTask} onDayClick={goDay} />
        )}
        {(view === 'week' || view === 'day') && (
          <WeekView key={view} from={range.from} count={view === 'day' ? 1 : 7} tasks={tasks} absences={absences} zoom={zoom} canEdit={canEdit}
            onOpen={(t) => setModal({ id: t.id })} onOpenAbsence={(a) => setModal({ absence: a })}
            onCreate={openCreate} onMove={moveTask} onDayClick={view === 'week' ? goDay : undefined} />
        )}
        {view === 'year' && (
          <YearView year={cursor.getFullYear()} tasks={tasks} absences={absences}
            onDayClick={goDay} onMonthClick={(d) => { setCursor(d); setView('month'); }} />
        )}
        {view === 'list' && <ListView tasks={tasks} onOpen={(t) => setModal({ id: t.id })} />}
      </div>

      {!canEdit && <div className="readonly-note"><Icon name="eye" size={14} /> Режим просмотра: изменения недоступны</div>}

      {(modal?.id || modal?.create) && (
        <TaskModal
          taskId={modal.id}
          createDefaults={modal.create}
          onClose={() => { setModal(null); if (window.location.hash.includes('task=')) history.replaceState(null, '', '#/calendar'); }}
          onChanged={load}
        />
      )}
      {(modal?.absence || modal?.newAbsence) && (
        <AbsenceModal absence={modal.absence} defaults={modal.newAbsence} onClose={() => setModal(null)} onSaved={load} />
      )}
    </div>
  );
}
