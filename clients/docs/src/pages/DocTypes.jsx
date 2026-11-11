import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';
import TypeBadge from '../components/TypeBadge.jsx';

const PALETTE = ['#0052CC', '#00875A', '#FF8B00', '#5243AA', '#DE350B', '#00A3BF', '#6554C0', '#FF5630', '#36B37E', '#6B778C'];

/** Справочник видов документов: добавление, переименование, цвет, порядок, удаление */
export default function DocTypes() {
  const { types, reloadTypes } = useAuth();
  const [edit, setEdit] = useState(null); // null | {} (новый) | тип
  const [error, setError] = useState('');

  const remove = async (t) => {
    if (!window.confirm(`Удалить вид «${t.name}»?`)) return;
    setError('');
    try { await api(`/doc-types/${t.code}`, { method: 'DELETE' }); await reloadTypes(); } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="breadcrumbs"><a href="/">ИТ-портал</a><span className="sep">/</span><Link to="/">Документы</Link><span className="sep">/</span><span>Виды документов</span></div>
      <div className="page-head">
        <h1>Виды документов</h1>
        <span className="count-badge">{types.length}</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setEdit({})}>+ Добавить вид</button>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>Вид выбирается при добавлении документа, по нему работают фильтр поиска и ограничения доступа сотрудников.</p>
      {error && <div className="alert">{error}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Вид</th><th>Документов</th><th>Порядок</th><th /></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.code} className="clickable" onClick={(e) => { if (!e.target.closest('button')) setEdit(t); }}>
                <td><TypeBadge code={t.code} /></td>
                <td>{t.count ? <Link to={`/?type=${t.code}`}>{t.count}</Link> : <span className="muted">0</span>}</td>
                <td className="muted">{t.sort}</td>
                <td className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEdit(t)}>Изменить</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(t)} disabled={t.count > 0}
                    title={t.count ? 'Есть документы этого вида' : 'Удалить'}>Удалить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TypeForm type={edit} onClose={() => setEdit(null)} onSaved={async () => { await reloadTypes(); setEdit(null); }} />}
    </div>
  );
}

function TypeForm({ type, onClose, onSaved }) {
  const isNew = !type.code;
  const { types } = useAuth();
  const [f, setF] = useState({ name: type.name || '', color: type.color || PALETTE[types.length % PALETTE.length], sort: type.sort ?? types.length + 1 });
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api(isNew ? '/doc-types' : `/doc-types/${type.code}`, { method: isNew ? 'POST' : 'PUT', body: f });
      await onSaved();
    } catch (err) { setError(err.message); }
  };
  return (
    <Modal title={isNew ? 'Новый вид документа' : `Вид «${type.name}»`} onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="alert">{error}</div>}
        <label className="field"><span>Название</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Например: Приказ" autoFocus required />
        </label>
        <div className="field"><span>Цвет</span>
          <div className="swatches">
            {PALETTE.map((c) => <button type="button" key={c} className={f.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setF({ ...f, color: c })} aria-label={c} />)}
          </div>
        </div>
        <label className="field"><span>Порядок в списке</span>
          <input className="input input-sm" type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary">{isNew ? 'Добавить' : 'Сохранить'}</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  );
}
