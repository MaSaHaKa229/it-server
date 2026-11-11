import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import { addDays, fmtDate, fmtShort, fromInputDate, nextOccurrence, toInputDate, toInputDateTime } from '../dates.js';
import { ABSENCE_KINDS, FREQS, freqByMonths, initials, PRIORITIES, shortName, STATUSES } from '../constants.js';
import Icon from './Icon.jsx';

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const COPIES = { daily: 'Каждый день', weekdays: 'По будням', weekly: 'Каждую неделю' };

/**
 * Форма задачи.
 * task — изменение задачи (или одного повтора регулярной задачи); series — изменение регулярной задачи целиком;
 * без них — новая задача (defaults: { start, end, allDay, repeat }).
 */
export default function TaskForm({ task, series, defaults, onSaved, onCancel }) {
  const { users, categories } = useApp();
  const init = series ?? task ?? {
    title: '', description: '', status: 'todo', priority: 'normal', category_id: null, assignees: [],
    start_at: defaults?.start ?? new Date(), end_at: defaults?.end ?? new Date(), all_day: defaults?.allDay ?? false,
  };
  const [f, setF] = useState({
    title: init.title,
    description: init.description,
    status: init.status ?? 'todo',
    priority: init.priority,
    category_id: init.category_id ?? '',
    assignees: (init.assignee_ids ?? init.assignees).map((a) => a.id ?? a),
    all_day: init.all_day,
    start: init.all_day ? toInputDate(init.start_at) : toInputDateTime(init.start_at),
    end: init.all_day ? toInputDate(init.end_at) : toInputDateTime(init.end_at),
    checklist: (series?.checklist ?? task?.checklist)?.map(({ text, done }) => ({ text, done: !!done })) ?? [],
    repeat: series ? freqByMonths(series.every_months) : (defaults?.repeat ?? ''),
    repeatCount: 4,
    until: series?.until ?? '',
  });
  const [newItem, setNewItem] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [absences, setAbsences] = useState([]);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const parse = (x) => (f.all_day ? fromInputDate(x) : new Date(x));
  const isSeries = !!FREQS[f.repeat];

  const toggleAllDay = (allDay) => {
    const p = (v) => (v.includes('T') ? new Date(v) : fromInputDate(v));
    const s = p(f.start); const e = p(f.end);
    if (allDay) setF((x) => ({ ...x, all_day: true, start: toInputDate(s), end: toInputDate(e) }));
    else {
      s.setHours(9, 0); const e2 = new Date(e); e2.setHours(10, 0);
      setF((x) => ({ ...x, all_day: false, start: toInputDateTime(s), end: toInputDateTime(e2) }));
    }
  };

  // При смене начала сдвигаем окончание, сохраняя длительность
  const changeStart = (v) => {
    const dur = parse(f.end) - parse(f.start);
    const ns = parse(v);
    if (isNaN(ns)) return set('start', v);
    const ne = new Date(ns.getTime() + Math.max(0, dur || 0));
    setF((x) => ({ ...x, start: v, end: f.all_day ? toInputDate(ne) : toInputDateTime(ne) }));
  };

  // Отсутствия сотрудников в даты задачи — чтобы предупредить при назначении
  const period = useMemo(() => {
    const s = parse(f.start), e = parse(f.end);
    return isNaN(s) || isNaN(e) ? null : { from: toInputDate(s), to: toInputDate(addDays(e, 1)) };
  }, [f.start, f.end, f.all_day]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!period) return undefined;
    let alive = true;
    const t = setTimeout(() => api.get('/absences' + qs(period)).then((d) => alive && setAbsences(d.absences)).catch(() => {}), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [period]);
  const absentOf = (id) => absences.filter((a) => a.user_id === id);
  const absentChosen = f.assignees.flatMap((id) => absentOf(id));

  const toggleAssignee = (id) => set('assignees', f.assignees.includes(id) ? f.assignees.filter((x) => x !== id) : [...f.assignees, id]);

  const addItem = () => {
    if (!newItem.trim()) return;
    set('checklist', [...f.checklist, { text: newItem.trim(), done: false }]);
    setNewItem('');
  };

  // Ближайший повтор регулярной задачи
  const next = useMemo(() => {
    if (!isSeries) return null;
    const s = parse(f.start), e = parse(f.end);
    if (isNaN(s) || isNaN(e) || e < s) return null;
    return nextOccurrence(s, e, FREQS[f.repeat].months, f.all_day, f.until || null);
  }, [isSeries, f.start, f.end, f.repeat, f.all_day, f.until]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const start = parse(f.start);
    const end = parse(f.end);
    if (end < start) return setError('Окончание не может быть раньше начала');
    if (isSeries && f.until && f.until < toInputDate(start)) return setError('Дата «Повторять до» раньше первой даты задачи');
    const common = {
      title: f.title, description: f.description, priority: f.priority,
      category_id: f.category_id ? Number(f.category_id) : null, assignees: f.assignees,
      all_day: f.all_day, start_at: start.toISOString(), end_at: end.toISOString(),
    };
    setBusy(true);
    try {
      let res;
      if (series) {
        res = await api.patch(`/series/${series.id}`, {
          ...common, freq: f.repeat, until: f.until || null, tz: TZ, checklist: f.checklist.map(({ text }) => ({ text })),
        });
      } else {
        const body = { ...common, status: f.status, checklist: f.checklist };
        if (!task && f.repeat) {
          body.repeat = isSeries ? { freq: f.repeat, until: f.until || null, tz: TZ } : { freq: f.repeat, count: Number(f.repeatCount) };
          if (isSeries) body.checklist = f.checklist.map(({ text }) => ({ text, done: false }));
        }
        res = task ? await api.patch(`/tasks/${task.id}`, body) : await api.post('/tasks', body);
      }
      onSaved(res.task, res.tasks?.length ?? 1, res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const seriesChangesDates = series && (toInputDateTime(series.start_at) !== toInputDateTime(parse(f.start))
    || toInputDateTime(series.end_at) !== toInputDateTime(parse(f.end)) || series.all_day !== f.all_day
    || freqByMonths(series.every_months) !== f.repeat || (series.until || '') !== f.until);

  return (
    <form className="task-form" onSubmit={submit}>
      {task?.series_id && (
        <div className="series-note">
          <Icon name="calendar" size={16} />
          <span>Это один повтор регулярной задачи — изменения коснутся только его. Чтобы изменить все будущие повторы,
            закройте форму и нажмите «Изменить все повторы».</span>
        </div>
      )}
      {series && (
        <div className="series-note">
          <Icon name="calendar" size={16} />
          <span>Изменения применятся к будущим повторам со статусом «К выполнению». Начатые, выполненные и прошедшие повторы не меняются.
            {seriesChangesDates && <b> Даты изменены — будущие повторы будут созданы заново (их комментарии и отметки будут удалены).</b>}</span>
        </div>
      )}

      <label className="field">
        <span>Название *</span>
        <input value={f.title} onChange={(e) => set('title', e.target.value)} required autoFocus maxLength={200} placeholder="Что нужно сделать?" />
      </label>

      <div className="form-grid">
        <label className="field">
          <span>{series ? 'Начало (первый повтор)' : 'Начало'}</span>
          <input type={f.all_day ? 'date' : 'datetime-local'} value={f.start} onChange={(e) => changeStart(e.target.value)} required />
        </label>
        <label className="field">
          <span>Окончание</span>
          <input type={f.all_day ? 'date' : 'datetime-local'} value={f.end} onChange={(e) => set('end', e.target.value)} required />
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={f.all_day} onChange={(e) => toggleAllDay(e.target.checked)} /> Весь день</label>

      {!task && (
        <div className="repeat-box">
          <div className="form-grid">
            <label className="field">
              <span>Повторять</span>
              <select value={f.repeat} onChange={(e) => set('repeat', e.target.value)}>
                {!series && <option value="">Не повторять</option>}
                <optgroup label="Регулярная задача (без ограничения по числу)">
                  {Object.entries(FREQS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </optgroup>
                {!series && (
                  <optgroup label="Несколько отдельных копий">
                    {Object.entries(COPIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            {isSeries && (
              <label className="field">
                <span>Повторять до (необязательно)</span>
                <input type="date" value={f.until} onChange={(e) => set('until', e.target.value)} />
              </label>
            )}
            {f.repeat && !isSeries && (
              <label className="field">
                <span>Количество повторений</span>
                <input type="number" min={2} max={52} value={f.repeatCount} onChange={(e) => set('repeatCount', e.target.value)} />
              </label>
            )}
          </div>
          {isSeries && (
            <div className="hint">
              {FREQS[f.repeat].label} задача будет появляться в календаре в эти же даты
              {f.until ? ` до ${fmtDate(fromInputDate(f.until), { day: 'numeric', month: 'long', year: 'numeric' })}` : ' без ограничения срока'}.
              {' '}У каждого повтора свой статус, чек-лист и комментарии.
              {next ? <> Ближайший повтор: <b>{fmtDate(next.start, { day: 'numeric', month: 'long', year: 'numeric' })}
                {f.all_day && toInputDate(next.start) !== toInputDate(next.end) && ` — ${fmtDate(next.end, { day: 'numeric', month: 'long', year: 'numeric' })}`}</b></>
                : ' Повторов больше не будет — проверьте даты.'}
            </div>
          )}
        </div>
      )}

      <div className={`form-grid ${series ? '' : 'three'}`}>
        {!series && (
          <label className="field">
            <span>Статус</span>
            <select value={f.status} onChange={(e) => set('status', e.target.value)}>
              {Object.entries(STATUSES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
            </select>
          </label>
        )}
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
          {users.filter((u) => u.is_active || f.assignees.includes(u.id)).map((u) => {
            const away = absentOf(u.id);
            return (
              <button type="button" key={u.id} className={`assignee ${f.assignees.includes(u.id) ? 'on' : ''} ${u.has_access === false ? 'no-access' : ''}`}
                onClick={() => toggleAssignee(u.id)}
                title={[u.has_access === false && 'Нет доступа к разделу «Задачи» — задачу в календаре не увидит',
                  ...away.map((a) => `${ABSENCE_KINDS[a.kind]?.label}: ${fmtShort(a.start_date)} — ${fmtShort(a.end_date)}`)].filter(Boolean).join('\n')}>
                <span className="avatar sm" style={{ background: u.color }}>{initials(u.name)}</span>{u.name}
                {u.has_access === false && <small className="no-access-mark">без доступа</small>}
                {away.length > 0 && <small className="away-mark" style={{ '--k': ABSENCE_KINDS[away[0].kind]?.color }}>{ABSENCE_KINDS[away[0].kind]?.label}</small>}
              </button>
            );
          })}
        </div>
        {users.some((u) => u.has_access === false && f.assignees.includes(u.id)) && (
          <div className="hint">Исполнители с пометкой «без доступа» не видят раздел «Задачи». Сообщите им о задаче или выдайте доступ в «Администрировании».</div>
        )}
        {absentChosen.length > 0 && (
          <div className="form-warn">
            В даты задачи отсутствуют: {absentChosen.map((a) => `${shortName(a.user_name)} (${ABSENCE_KINDS[a.kind]?.label.toLowerCase()} ${fmtShort(a.start_date)} — ${fmtShort(a.end_date)})`).join(', ')}
          </div>
        )}
      </div>

      <label className="field">
        <span>Описание</span>
        <textarea rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Детали, ссылки, ожидаемый результат" />
      </label>

      <div className="field">
        <span>Чек-лист{isSeries ? ' (в каждом повторе — заново)' : ''}</span>
        {f.checklist.map((it, i) => (
          <div key={i} className="check-edit">
            {!isSeries && !series
              ? <input type="checkbox" checked={it.done} onChange={(e) => set('checklist', f.checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
              : <Icon name="check" size={14} />}
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

      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Отмена</button>
        <button className="btn primary" disabled={busy}>{busy ? 'Сохранение…' : task || series ? 'Сохранить' : 'Создать'}</button>
      </div>
    </form>
  );
}
