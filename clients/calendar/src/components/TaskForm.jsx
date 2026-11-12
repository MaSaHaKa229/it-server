import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import { addDays, fmtDate, fmtShort, fromInputDate, nextOccurrence, nextOccurrenceDays, toInputDate, toInputDateTime } from '../dates.js';
import { ABSENCE_KINDS, COLOR_MODES, FREQS, freqByMonths, initials, PALETTE, PRIORITIES, shortName, STATUSES, WEEKDAYS } from '../constants.js';
import Icon from './Icon.jsx';

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();

/**
 * Форма задачи.
 * task — изменение задачи (или одного повтора регулярной задачи); series — изменение регулярной задачи целиком;
 * без них — новая задача (defaults: { start, end, allDay, repeat }).
 */
export default function TaskForm({ task, series, defaults, onSaved, onCancel }) {
  const { users, categories, colorModes } = useApp();
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
    color: init.color ?? '',
    assignees: (init.assignee_ids ?? init.assignees).map((a) => a.id ?? a),
    all_day: init.all_day,
    start: init.all_day ? toInputDate(init.start_at) : toInputDateTime(init.start_at),
    end: init.all_day ? toInputDate(init.end_at) : toInputDateTime(init.end_at),
    checklist: (series?.checklist ?? task?.checklist)?.map(({ text, done }) => ({ text, done: !!done })) ?? [],
    repeat: series ? (series.freq || freqByMonths(series.every_months)) : (defaults?.repeat ?? ''),
    weekdays: series?.weekdays ?? [],
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
    const fr = FREQS[f.repeat];
    if (fr.days) return nextOccurrenceDays(s, e, fr.days, fr.pickDays ? f.weekdays : fr.weekdays, f.all_day, f.until || null);
    return nextOccurrence(s, e, fr.months, f.all_day, f.until || null);
  }, [isSeries, f.start, f.end, f.repeat, f.all_day, f.until, f.weekdays]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const start = parse(f.start);
    const end = parse(f.end);
    if (end < start) return setError('Окончание не может быть раньше начала');
    if (isSeries && f.until && f.until < toInputDate(start)) return setError('Дата «Повторять до» раньше первой даты задачи');
    const common = {
      title: f.title, description: f.description, priority: f.priority,
      category_id: f.category_id ? Number(f.category_id) : null, assignees: f.assignees, color: f.color || null,
      all_day: f.all_day, start_at: start.toISOString(), end_at: end.toISOString(),
    };
    setBusy(true);
    try {
      let res;
      if (series) {
        res = await api.patch(`/series/${series.id}`, {
          ...common, freq: f.repeat, weekdays: f.weekdays, until: f.until || null, tz: TZ, checklist: f.checklist.map(({ text }) => ({ text })),
        });
      } else {
        const body = { ...common, status: f.status, checklist: f.checklist };
        if (!task && f.repeat) {
          body.repeat = { freq: f.repeat, weekdays: f.weekdays, until: f.until || null, tz: TZ };
          if (isSeries) body.checklist = f.checklist.map(({ text }) => ({ text, done: false }));
        }
        res = task ? await api.patch(`/tasks/${task.id}`, body) : await api.post('/tasks', body);
      }
      onSaved(res.task, res.tasks?.length ?? 1, res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const seriesChangesDates = series && (toInputDateTime(series.start_at) !== toInputDateTime(parse(f.start))
    || toInputDateTime(series.end_at) !== toInputDateTime(parse(f.end)) || series.all_day !== f.all_day
    || (series.freq || freqByMonths(series.every_months)) !== f.repeat || (series.until || '') !== f.until
    || JSON.stringify(series.weekdays || []) !== JSON.stringify([...f.weekdays].sort()));

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
                <optgroup label="По дням и неделям">
                  {Object.entries(FREQS).filter(([, v]) => v.days).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </optgroup>
                <optgroup label="По месяцам">
                  {Object.entries(FREQS).filter(([, v]) => v.months).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </optgroup>
              </select>
            </label>
            {isSeries && (
              <label className="field">
                <span>Повторять до (необязательно)</span>
                <input type="date" value={f.until} onChange={(e) => set('until', e.target.value)} />
              </label>
            )}
            {isSeries && FREQS[f.repeat].pickDays && (
              <div className="field">
                <span>Дни недели</span>
                <div className="weekday-pick">
                  {WEEKDAYS.map((w, i) => (
                    <label key={w} className={f.weekdays.includes(i + 1) ? 'on' : ''}>
                      <input type="checkbox" checked={f.weekdays.includes(i + 1)}
                        onChange={(e) => set('weekdays', e.target.checked ? [...f.weekdays, i + 1].sort() : f.weekdays.filter((x) => x !== i + 1))} />
                      {w}
                    </label>
                  ))}
                </div>
                <small className="muted">Не отмечено — в тот же день недели, что и первая задача</small>
              </div>
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
        <span>Цвет в календаре</span>
        <div className="color-pick">
          <button type="button" className={`color-auto ${f.color ? '' : 'on'}`} onClick={() => set('color', '')}
            title="Цвет по общей настройке раскраски">Авто ({COLOR_MODES.tasks[colorModes.tasks]})</button>
          {PALETTE.map((c) => (
            <button type="button" key={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} title={c} />
          ))}
          <label className={`swatch-input ${f.color && !PALETTE.includes(f.color) ? 'on' : ''}`} style={{ background: f.color && !PALETTE.includes(f.color) ? f.color : undefined }} title="Любой цвет">
            <input type="color" value={f.color || '#0052cc'} onChange={(e) => set('color', e.target.value)} />
            {!(f.color && !PALETTE.includes(f.color)) && '…'}
          </label>
        </div>
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
