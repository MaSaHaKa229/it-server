import { ABSENCE_KINDS, absenceColor, shortName } from '../constants.js';
import { fmtShort } from '../dates.js';

/** Плашка отсутствия сотрудника в календаре */
export default function AbsenceChip({ a, onClick }) {
  const k = ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other;
  return (
    <button className="abs-chip" style={{ '--k': absenceColor(a) }}
      onClick={(e) => { e.stopPropagation(); onClick?.(a); }} onDoubleClick={(e) => e.stopPropagation()}
      title={`${a.user_name} — ${k.label.toLowerCase()} ${fmtShort(a.start_date)} — ${fmtShort(a.end_date)}${a.comment ? `\n${a.comment}` : ''}`}>
      <span className="abs-kind">{k.label}</span>
      <span className="abs-who">{shortName(a.user_name)}</span>
    </button>
  );
}
