import { useEffect, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import { addDays, fmtTaskPeriod, startOfDay } from '../dates.js';
import { initials, PRIORITIES, STATUSES, taskColor } from '../constants.js';
import TaskModal from '../components/TaskModal.jsx';

export default function Dashboard() {
  const { user, toast } = useApp();
  const [stats, setStats] = useState(null);
  const [mine, setMine] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [open, setOpen] = useState(null);

  const load = () => {
    const from = startOfDay(new Date());
    Promise.all([
      api.get('/stats'),
      api.get('/tasks' + qs({ mine: '1', from, to: addDays(from, 14), status: 'todo,in_progress', limit: 20 })),
      api.get('/tasks' + qs({ overdue: '1', limit: 20 })),
    ]).then(([s, m, o]) => { setStats(s); setMine(m.tasks); setOverdue(o.tasks); }).catch((e) => toast(e.message, 'err'));
  };
  useEffect(load, []);

  if (!stats) return <div className="page"><div className="spinner" /></div>;
  const total = Object.values(stats.byStatus).reduce((a, b) => a + b, 0) || 1;
  const maxOpen = Math.max(1, ...stats.workload.map((w) => w.open));

  const TaskRow = ({ t }) => (
    <button className="mini-task" onClick={() => setOpen(t.id)} style={{ '--c': taskColor(t) }}>
      <b>{t.title}</b>
      <small>{fmtTaskPeriod(t)}</small>
      <span className="pill" style={{ '--p': PRIORITIES[t.priority].color }}>{PRIORITIES[t.priority].label}</span>
    </button>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h2>{user.is_system ? 'Добрый день!' : `Добрый день, ${user.name.split(' ')[0]}!`}</h2>
        <p className="muted">Сводка по задачам службы ИТ</p>
      </header>

      <div className="stat-row">
        <div className="stat"><small>Сегодня в работе</small><b>{stats.today}</b></div>
        <div className="stat"><small>Мои открытые</small><b>{stats.mineOpen}</b></div>
        <div className={`stat ${stats.overdue ? 'danger' : ''}`}><small>Просрочено</small><b>{stats.overdue}</b></div>
        <div className="stat"><small>Выполнено всего</small><b>{stats.byStatus.done || 0}</b></div>
      </div>

      <div className="card">
        <h3>Задачи по статусам</h3>
        <div className="stack-bar">
          {Object.entries(STATUSES).map(([k, s]) => stats.byStatus[k] ? (
            <div key={k} style={{ width: `${(stats.byStatus[k] / total) * 100}%`, background: s.color }} title={`${s.label}: ${stats.byStatus[k]}`} />
          ) : null)}
        </div>
        <div className="legend">
          {Object.entries(STATUSES).map(([k, s]) => (
            <span key={k}><i style={{ background: s.color }} />{s.label} — {stats.byStatus[k] || 0}</span>
          ))}
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <h3>Мои задачи на 2 недели</h3>
          {mine.length ? mine.map((t) => <TaskRow key={t.id} t={t} />) : <p className="muted">Открытых задач нет</p>}
        </div>
        <div className="card">
          <h3>Просроченные задачи службы ИТ</h3>
          {overdue.length ? overdue.map((t) => <TaskRow key={t.id} t={t} />) : <p className="muted">Всё в срок 👍</p>}
        </div>
      </div>

      <div className="card">
        <h3>Загрузка сотрудников</h3>
        <table className="table">
          <thead><tr><th>Сотрудник</th><th>Открытые</th><th className="hide-sm">Просрочено</th><th className="hide-sm">Выполнено за 30 дней</th></tr></thead>
          <tbody>
            {stats.workload.map((w) => (
              <tr key={w.id}>
                <td><span className="person"><span className="avatar sm" style={{ background: w.color }}>{initials(w.name)}</span>{w.name}</span></td>
                <td>
                  <div className="load"><div style={{ width: `${(w.open / maxOpen) * 100}%` }} /><span>{w.open}</span></div>
                </td>
                <td className={`hide-sm ${w.overdue ? 'danger' : ''}`}>{w.overdue}</td>
                <td className="hide-sm">{w.done_30d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && <TaskModal taskId={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
