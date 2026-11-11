import { useEffect, useRef, useState } from 'react';

/**
 * Выпадающий список с галочками. value — массив выбранных значений (строки).
 * options — [{ value, label, color?, avatar? }]; пустой выбор = «все».
 */
export default function MultiSelect({ label, allLabel, options, value, onChange, searchable }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const chosen = options.filter((o) => value.includes(o.value));
  const text = !chosen.length ? allLabel : chosen.length === 1 ? chosen[0].label : `${label}: ${chosen.length}`;
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;

  return (
    <div className="ms" ref={ref}>
      <button type="button" className={`ms-btn ${chosen.length ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} title={chosen.map((c) => c.label).join(', ')}>
        <span className="ms-text">{text}</span><span className="ms-caret">▾</span>
      </button>
      {open && (
        <div className="ms-pop">
          {searchable && <input className="ms-search" placeholder="Найти…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
          <div className="ms-list">
            {shown.map((o) => (
              <label key={o.value} className={`ms-item ${o.divider ? 'divider' : ''}`}>
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                {o.color && <i className="dot" style={{ background: o.color }} />}
                <span>{o.label}</span>
              </label>
            ))}
            {!shown.length && <div className="ms-empty">Ничего не найдено</div>}
          </div>
          <div className="ms-foot">
            <button type="button" className="link" onClick={() => onChange([])} disabled={!value.length}>Сбросить</button>
            <button type="button" className="link" onClick={() => setOpen(false)}>Готово</button>
          </div>
        </div>
      )}
    </div>
  );
}
