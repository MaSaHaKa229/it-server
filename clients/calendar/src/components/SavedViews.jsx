// Сохранённые фильтры календаря (у каждого свои; «общие» видят все) — хранятся на сервере портала
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

async function call(method, url, body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'portal', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Ошибка ${r.status}`);
  return d;
}

export default function SavedViews({ filters, onApply }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const load = () => call('GET', '/api/my/views?section=calendar').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const out = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setSaving(false); } };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, []);
  const save = async () => {
    try {
      await call('POST', '/api/my/views', { section: 'calendar', name, shared, params: { filters } });
      setName(''); setShared(false); setSaving(false); setError(''); load();
    } catch (e) { setError(e.message); }
  };
  const del = async (v) => {
    if (!window.confirm(`Удалить фильтр «${v.name}»?`)) return;
    await call('DELETE', '/api/my/views/' + v.id).catch((e) => window.alert(e.message));
    load();
  };
  return (
    <div className="saved-views" ref={ref}>
      <button className="btn ghost small" onClick={() => setOpen((x) => !x)} title="Сохранённые фильтры">
        <Icon name="filter" size={14} /> Мои фильтры{list.length ? ` (${list.length})` : ''} ▾
      </button>
      {open && (
        <div className="saved-pop">
          {list.length === 0 && !saving && <div className="saved-empty">Сохранённых фильтров пока нет</div>}
          {list.map((v) => (
            <div key={v.id} className="saved-item">
              <button className="saved-apply" onClick={() => { onApply(v.params.filters || {}); setOpen(false); }}
                title={v.mine ? '' : `Общий фильтр (${v.owner})`}>
                {v.shared ? '👥 ' : ''}{v.name}
              </button>
              {v.mine && <button className="icon-btn tiny" title="Удалить" onClick={() => del(v)}><Icon name="x" size={12} /></button>}
            </div>
          ))}
          <div className="saved-foot">
            {saving ? (
              <div className="saved-form">
                <input autoFocus placeholder="Название фильтра" value={name} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
                <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Общий — для всех</label>
                {error && <div className="saved-error">{error}</div>}
                <div className="saved-buttons">
                  <button className="btn small" onClick={() => setSaving(false)}>Отмена</button>
                  <button className="btn primary small" onClick={save}>Сохранить</button>
                </div>
              </div>
            ) : (
              <button className="btn ghost small" onClick={() => setSaving(true)}>+ Сохранить текущие фильтры</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
