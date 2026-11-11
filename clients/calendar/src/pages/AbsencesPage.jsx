// График отпусков и других отсутствий сотрудников на год
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context.jsx';
import { ABSENCE_KINDS, absenceColor, initials } from '../constants.js';
import { daysBetween, fmtShort, fromInputDate, toInputDate } from '../dates.js';
import Icon from '../components/Icon.jsx';
import MultiSelect from '../components/MultiSelect.jsx';
import AbsenceModal, { useAbsenceRights } from '../components/AbsenceModal.jsx';

const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString('ru-RU', { month: 'short' }).replace('.', ''));

export default function AbsencesPage() {
  const { users, user, canEdit, toast } = useApp();
  const canManage = useAbsenceRights();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [kinds, setKinds] = useState([]);
  const [who, setWho] = useState([]);
  const [items, setItems] = useState(null);
  const [modal, setModal] = useState(null);

  const load = useCallback(() => {
    api.get('/absences' + qs({ from: `${year}-01-01`, to: `${year + 1}-01-01`, kind: kinds, user: who }))
      .then((d) => setItems(d.absences)).catch((e) => toast(e.message, 'err'));
  }, [year, kinds, who, toast]);
  useEffect(() => { load(); }, [load]);

  const y0 = new Date(year, 0, 1);
  const total = Math.round((new Date(year + 1, 0, 1) - y0) / 86400000);
  const dayIdx = (s) => Math.round((fromInputDate(s) - y0) / 86400000);
  const clamp = (v) => Math.max(0, Math.min(total, v));

  // Строки графика: активные сотрудники с доступом к календарю и все, у кого есть отсутствия в этом году
  const rows = useMemo(() => {
    const list = items || [];
    const ids = new Set(list.map((a) => a.user_id));
    return users
      .filter((u) => (who.length ? who.includes(String(u.id)) : (u.is_active && u.has_access !== false) || ids.has(u.id)))
      .map((u) => {
        const own = list.filter((a) => a.user_id === u.id);
        // Дни в пределах года по видам
        const days = {};
        for (const a of own) {
          const s = clamp(dayIdx(a.start_date)), e = clamp(dayIdx(a.end_date) + 1);
          days[a.kind] = (days[a.kind] || 0) + Math.max(0, e - s);
        }
        return { u, own, days };
      });
  }, [users, items, who, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = MONTHS.map((name, m) => ({
    name, left: (dayIdx(toInputDate(new Date(year, m, 1))) / total) * 100,
    width: (new Date(year, m + 1, 0).getDate() / total) * 100,
  }));
  const today = new Date();
  const todayPos = today.getFullYear() === year ? ((dayIdx(toInputDate(today)) + 0.5) / total) * 100 : null;

  // Щелчок по пустому месту строки — новое отсутствие с этого дня
  const clickRow = (e, u) => {
    if (!canManage(u.id) || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    const d = new Date(year, 0, 1 + Math.floor(((e.clientX - r.left) / r.width) * total));
    setModal({ defaults: { user_id: u.id, start_date: toInputDate(d), end_date: toInputDate(d) } });
  };

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h2>Отпуска и отсутствия</h2>
          <p className="muted">График службы ИТ на год. {canEdit ? 'Щёлкните по строке сотрудника, чтобы отметить отсутствие с этого дня.' : ''}</p>
        </div>
        <div className="toolbar-right">
          <span className="btn-group">
            <button className="icon-btn" onClick={() => setYear((y) => y - 1)} aria-label="Предыдущий год"><Icon name="left" /></button>
            <b className="year-title">{year}</b>
            <button className="icon-btn" onClick={() => setYear((y) => y + 1)} aria-label="Следующий год"><Icon name="right" /></button>
          </span>
          <a className="btn" title="Выгрузить в Excel отсутствия за год"
            href={'/calendar/api/absences/export.xlsx' + qs({ from: `${year}-01-01`, to: `${year + 1}-01-01`, kind: kinds, user: who })}>Excel</a>
          <MultiSelect label="Сотрудники" allLabel="Все сотрудники" searchable value={who} onChange={setWho}
            options={users.filter((u) => u.is_active).map((u) => ({ value: String(u.id), label: u.name, color: u.color }))} />
          <MultiSelect label="Виды" allLabel="Все виды" value={kinds} onChange={setKinds}
            options={Object.entries(ABSENCE_KINDS).map(([k, v]) => ({ value: k, label: v.label, color: v.color }))} />
          {canEdit && <button className="btn primary" onClick={() => setModal({ defaults: { user_id: user.id } })}><Icon name="plus" /> Добавить</button>}
        </div>
      </header>

      {!items ? <div className="spinner" /> : (
        <>
          <div className="card flush">
            <div className="tl">
              <div className="tl-row tl-head">
                <div className="tl-name">Сотрудник</div>
                <div className="tl-track">
                  {months.map((m) => <span key={m.name} className="tl-month" style={{ left: `${m.left}%`, width: `${m.width}%` }}>{m.name}</span>)}
                </div>
                <div className="tl-sum" title="Дней отпуска в году (календарных)">Отпуск, дн.</div>
              </div>
              {rows.map(({ u, own, days }) => (
                <div key={u.id} className="tl-row">
                  <div className="tl-name"><span className="person"><span className="avatar sm" style={{ background: u.color }}>{initials(u.name)}</span><span className="tl-uname">{u.name}</span></span></div>
                  <div className={`tl-track ${canManage(u.id) ? 'editable' : ''}`} onClick={(e) => clickRow(e, u)}>
                    {months.map((m, i) => i % 2 === 1 && <span key={m.name} className="tl-stripe" style={{ left: `${m.left}%`, width: `${m.width}%` }} />)}
                    {todayPos !== null && <span className="tl-today" style={{ left: `${todayPos}%` }} />}
                    {own.map((a) => {
                      const s = clamp(dayIdx(a.start_date)), e = clamp(dayIdx(a.end_date) + 1);
                      const k = ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other;
                      return (
                        <button key={a.id} className="tl-bar" style={{ left: `${(s / total) * 100}%`, width: `${((e - s) / total) * 100}%`, '--k': absenceColor(a) }}
                          onClick={() => setModal({ absence: a })}
                          title={`${k.label}: ${fmtShort(a.start_date)} — ${fmtShort(a.end_date)} (${daysBetween(a.start_date, a.end_date)} дн.)${a.comment ? `\n${a.comment}` : ''}`} />
                      );
                    })}
                  </div>
                  <div className="tl-sum">{days.vacation || '—'}</div>
                </div>
              ))}
              {!rows.length && <p className="muted pad">Нет сотрудников</p>}
            </div>
            <div className="legend pad-x">
              {Object.entries(ABSENCE_KINDS).map(([k, v]) => <span key={k}><i style={{ background: v.color }} />{v.label}</span>)}
            </div>
          </div>

          <div className="card flush">
            <h3 className="pad-h">Список за {year} год</h3>
            {items.length ? (
              <table className="table">
                <thead><tr><th>Сотрудник</th><th>Вид</th><th>Даты</th><th>Дней</th><th>Комментарий</th></tr></thead>
                <tbody>
                  {items.map((a) => {
                    const k = ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other;
                    return (
                      <tr key={a.id} className="clickable" onClick={() => setModal({ absence: a })}>
                        <td><span className="person"><span className="avatar sm" style={{ background: a.user_color }}>{initials(a.user_name)}</span>{a.user_name}</span></td>
                        <td><span className="pill" style={{ '--p': k.color }}>{k.label}</span></td>
                        <td>{fmtShort(a.start_date)} — {fromInputDate(a.end_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                        <td>{daysBetween(a.start_date, a.end_date)}</td>
                        <td className="muted">{a.comment}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <p className="muted pad">За {year} год отсутствий нет</p>}
          </div>
        </>
      )}

      {modal && <AbsenceModal absence={modal.absence} defaults={modal.defaults} onClose={() => setModal(null)} onSaved={load} />}
    </div>
  );
}
