import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';

const PALETTE = ['#0052CC', '#00875A', '#FF8B00', '#5243AA', '#DE350B', '#00A3BF', '#6554C0', '#FF5630', '#36B37E', '#6B778C'];

/** Управление папками (дерево) и тегами */
export default function Folders() {
  const { folders, tags, reloadTypes, restrictedFolders, portal } = useAuth();
  const [editFolder, setEditFolder] = useState(null); // null | { parent_id } (новая) | папка
  const [editTag, setEditTag] = useState(null);
  const [error, setError] = useState('');

  const act = async (fn) => {
    setError('');
    try { await fn(); await reloadTypes(); } catch (e) { setError(e.message); }
  };
  const removeFolder = (f) => window.confirm(`Удалить папку «${f.name}»?`) && act(() => api(`/folders/${f.id}`, { method: 'DELETE' }));
  const removeTag = (t) => window.confirm(`Удалить тег «${t.name}»? Он будет снят со всех документов (${t.count}).`)
    && act(() => api(`/tags/${t.id}`, { method: 'DELETE' }));

  return (
    <div>
      <div className="breadcrumbs"><a href="/">ИТ-портал</a><span className="sep">/</span><Link to="/">Документы</Link><span className="sep">/</span><span>Папки и теги</span></div>
      {error && <div className="alert">{error}</div>}

      <div className="page-head">
        <h1>Папки</h1>
        <span className="count-badge">{folders.length}</span>
        <span className="spacer" />
        {!restrictedFolders && <button className="btn btn-primary" onClick={() => setEditFolder({ parent_id: '' })}>+ Создать папку</button>}
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Папки можно вкладывать друг в друга. Доступ сотрудников к папкам выдаёт администратор портала
        {portal?.user?.isAdmin ? <> в разделе <a href="/admin">«Администрирование»</a></> : ' в разделе «Администрирование»'}
        : доступ к папке открывает и все вложенные в неё.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Папка</th><th>Документов</th><th>С вложенными</th><th /></tr></thead>
          <tbody>
            {folders.map((f) => (
              <tr key={f.id}>
                <td><span style={{ paddingLeft: f.level * 20 }}>📁 <Link to={`/?folder=${f.id}`}>{f.name}</Link></span></td>
                <td>{f.count || <span className="muted">0</span>}</td>
                <td>{f.total || <span className="muted">0</span>}</td>
                <td className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditFolder({ parent_id: String(f.id) })}>+ Вложенная</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditFolder(f)}>Изменить</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeFolder(f)} disabled={f.total > 0}
                    title={f.total ? 'В папке есть документы' : 'Удалить'}>Удалить</button>
                </td>
              </tr>
            ))}
            {!folders.length && <tr><td colSpan={4} className="empty">Папок пока нет. Создайте первую — например, «Приказы» или «ГОСТы».</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="page-head" style={{ marginTop: 40 }}>
        <h1>Теги</h1>
        <span className="count-badge">{tags.length}</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditTag({})}>+ Создать тег</button>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Тегами помечают документы из разных папок: «Срочно», «Охрана труда», «На подпись». Тег можно ввести и прямо в форме документа.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Тег</th><th>Документов</th><th /></tr></thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id}>
                <td><span className="tag" style={{ '--tag': t.color }}>{t.name}</span></td>
                <td>{t.count ? <Link to={`/?tag=${t.id}`}>{t.count}</Link> : <span className="muted">0</span>}</td>
                <td className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditTag(t)}>Изменить</button>
                  {!restrictedFolders && <button className="btn btn-ghost btn-sm" onClick={() => removeTag(t)}>Удалить</button>}
                </td>
              </tr>
            ))}
            {!tags.length && <tr><td colSpan={3} className="empty">Тегов пока нет</td></tr>}
          </tbody>
        </table>
      </div>

      {editFolder && <FolderForm folder={editFolder} onClose={() => setEditFolder(null)} onSaved={async () => { await reloadTypes(); setEditFolder(null); }} />}
      {editTag && <TagForm tag={editTag} onClose={() => setEditTag(null)} onSaved={async () => { await reloadTypes(); setEditTag(null); }} />}
    </div>
  );
}

function FolderForm({ folder, onClose, onSaved }) {
  const { folders, restrictedFolders } = useAuth();
  const isNew = !folder.id;
  const [f, setF] = useState({ name: folder.name || '', parent_id: folder.parent_id ? String(folder.parent_id) : '', sort: folder.sort ?? 0 });
  const [error, setError] = useState('');
  // Папку нельзя переместить в саму себя или во вложенную: исключаем её ветку из списка
  const branch = new Set();
  if (!isNew) {
    branch.add(folder.id);
    for (const x of folders) if (branch.has(x.parent_id)) branch.add(x.id);
  }
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api(isNew ? '/folders' : `/folders/${folder.id}`, { method: isNew ? 'POST' : 'PUT', body: { ...f, parent_id: f.parent_id || null } });
      await onSaved();
    } catch (err) { setError(err.message); }
  };
  return (
    <Modal title={isNew ? 'Новая папка' : `Папка «${folder.name}»`} onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="alert">{error}</div>}
        <label className="field"><span>Название</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus required />
        </label>
        <label className="field"><span>Находится в папке</span>
          <select className="input" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })} required={restrictedFolders}>
            {!restrictedFolders && <option value="">— верхний уровень —</option>}
            {folders.filter((x) => !branch.has(x.id)).map((x) => <option key={x.id} value={x.id}>{'   '.repeat(x.level) + x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Порядок в списке (меньше — выше)</span>
          <input className="input input-sm" type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary">{isNew ? 'Создать' : 'Сохранить'}</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  );
}

function TagForm({ tag, onClose, onSaved }) {
  const { tags } = useAuth();
  const isNew = !tag.id;
  const [f, setF] = useState({ name: tag.name || '', color: tag.color || PALETTE[tags.length % PALETTE.length] });
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api(isNew ? '/tags' : `/tags/${tag.id}`, { method: isNew ? 'POST' : 'PUT', body: f });
      await onSaved();
    } catch (err) { setError(err.message); }
  };
  return (
    <Modal title={isNew ? 'Новый тег' : `Тег «${tag.name}»`} onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="alert">{error}</div>}
        <label className="field"><span>Название</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus required />
        </label>
        <div className="field"><span>Цвет</span>
          <div className="swatches">
            {PALETTE.map((c) => <button type="button" key={c} className={f.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setF({ ...f, color: c })} aria-label={c} />)}
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary">{isNew ? 'Создать' : 'Сохранить'}</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  );
}
