import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { ABSENCE_KINDS } from '../constants.js';
import { daysBetween, toInputDate } from '../dates.js';
import Modal from './Modal.jsx';

/** Может ли текущий пользователь менять отсутствия этого сотрудника */
export function useAbsenceRights() {
  const { user, isAdmin, canEdit } = useApp();
  return (userId) => isAdmin || (canEdit && userId === user.id);
}

/**
 * Добавление / изменение отсутствия сотрудника.
 * absence — существующая запись; defaults — { user_id, start_date, end_date } для новой.
 */
export default function AbsenceModal({ absence, defaults, onClose, onSaved }) {
  const { users, user, isAdmin, toast } = useApp();
  const canManage = useAbsenceRights();
  const editable = absence ? canManage(absence.user_id) : true;
  const today = toInputDate(new Date());
  const [f, setF] = useState(() => ({
    user_id: absence?.user_id ?? defaults?.user_id ?? user.id,
    kind: absence?.kind ?? defaults?.kind ?? 'vacation',
    start_date: absence?.start_date ?? defaults?.start_date ?? today,
    end_date: absence?.end_date ?? defaults?.end_date ?? defaults?.start_date ?? today,
    comment: absence?.comment ?? '',
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const people = users.filter((u) => u.is_active || u.id === f.user_id);
  const days = f.start_date && f.end_date && f.end_date >= f.start_date ? daysBetween(f.start_date, f.end_date) : 0;

  const save = async (e) => {
    e.preventDefault();
    setError('');
    if (f.end_date < f.start_date) return setError('Окончание не может быть раньше начала');
    setBusy(true);
    try {
      const body = { ...f, user_id: Number(f.user_id) };
      if (absence) await api.patch(`/absences/${absence.id}`, body); else await api.post('/absences', body);
      toast(absence ? 'Изменения сохранены' : 'Отсутствие добавлено');
      onSaved(); onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('Удалить запись об отсутствии?')) return;
    try { await api.del(`/absences/${absence.id}`); toast('Запись удалена'); onSaved(); onClose(); } catch (err) { toast(err.message, 'err'); }
  };

  const title = absence ? (editable ? 'Отсутствие сотрудника' : `${ABSENCE_KINDS[absence.kind]?.label || 'Отсутствие'}: ${absence.user_name}`) : 'Новое отсутствие';
  return (
    <Modal title={title} onClose={onClose}>
      <form className="task-form" onSubmit={save}>
        <label className="field">
          <span>Сотрудник</span>
          <select value={f.user_id} onChange={(e) => set('user_id', Number(e.target.value))} disabled={!editable || !isAdmin}>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <div className="field">
          <span>Вид</span>
          <div className="kind-pick">
            {Object.entries(ABSENCE_KINDS).map(([k, v]) => (
              <button type="button" key={k} disabled={!editable} className={`kind ${f.kind === k ? 'on' : ''}`} style={{ '--k': v.color }} onClick={() => set('kind', k)}>{v.label}</button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <label className="field"><span>С</span>
            <input type="date" value={f.start_date} disabled={!editable} required
              onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, start_date: v, end_date: x.end_date < v ? v : x.end_date })); }} />
          </label>
          <label className="field"><span>По (включительно)</span>
            <input type="date" value={f.end_date} min={f.start_date} disabled={!editable} required onChange={(e) => set('end_date', e.target.value)} />
          </label>
        </div>
        {days > 0 && <div className="hint">Календарных дней: {days}</div>}
        <label className="field"><span>Комментарий</span>
          <input value={f.comment} maxLength={1000} disabled={!editable} onChange={(e) => set('comment', e.target.value)} placeholder="Например: замещает Петров" />
        </label>
        {absence?.created_by_name && <p className="muted small">Добавил(а): {absence.created_by_name}</p>}
        {!editable && <p className="muted small">Изменять отсутствия может администратор календаря или сам сотрудник (с правом редактирования).</p>}
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          {absence && editable && <button type="button" className="btn ghost danger-text" onClick={remove}>Удалить</button>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>{editable ? 'Отмена' : 'Закрыть'}</button>
          {editable && <button className="btn primary" disabled={busy}>{busy ? 'Сохранение…' : absence ? 'Сохранить' : 'Добавить'}</button>}
        </div>
      </form>
    </Modal>
  );
}
