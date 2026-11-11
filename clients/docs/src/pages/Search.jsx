import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { DOC_STATUSES, canEdit, formatDate } from '../constants.js';
import TypeBadge from '../components/TypeBadge.jsx';
import { TagList } from '../components/Tags.jsx';
import Pagination from '../components/Pagination.jsx';

const LIMIT = 20;

/** Фрагмент текста с подсветкой найденных слов (сервер размечает их ⟦…⟧) */
function Snippet({ text }) {
  if (!text) return null;
  const clean = text
    .replace(/\[([^\]]*)\]\(doc:\d+\)/g, '$1')
    .replace(/[#*`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = clean.split(/(⟦[^⟧]*⟧)/g);
  return (
    <p className="snippet">
      {parts.map((s, i) =>
        s.startsWith('⟦') ? <mark key={i}>{s.slice(1, -1)}</mark> : <span key={i}>{s}</span>
      )}
      {clean.length >= 280 && '…'}
    </p>
  );
}

export default function Search() {
  const { user, docTypes, typeMap, folders, folderMap, tags, restrictedFolders } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const mode = params.get('mode') || 'all';
  const type = params.get('type') || '';
  const status = params.get('status') || '';
  const folder = params.get('folder') || '';
  const tag = params.get('tag') || '';
  const sort = params.get('sort') || '';
  const page = Number(params.get('page')) || 1;

  const [text, setText] = useState(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => setText(q), [q]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ mode, page: String(page), limit: String(LIMIT) });
    if (q) query.set('q', q);
    if (type) query.set('type', type);
    if (status) query.set('status', status);
    if (folder) query.set('folder', folder);
    if (tag) query.set('tag', tag);
    if (sort) query.set('sort', sort);
    api(`/documents?${query}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [q, mode, type, status, folder, tag, sort, page]);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  }

  const curFolder = folder && folder !== '0' ? folderMap[folder] : null;
  const curTag = tag ? tags.find((t) => String(t.id) === tag) : null;
  const title = curFolder ? curFolder.name : folder === '0' ? 'Без папки' : curTag ? `Тег «${curTag.name}»`
    : type ? (typeMap[type]?.name || 'Документы') : 'Все документы';
  return (
    <div>
      <div className="breadcrumbs">
        <a href="/">ИТ-портал</a><span className="sep">/</span><Link to="/">Документы</Link>
        {curFolder && curFolder.path.split(' / ').slice(0, -1).map((n, i) => <span key={i}><span className="sep">/ </span>{n}</span>)}
        {(curFolder || folder === '0' || curTag) && <><span className="sep">/</span><span>{title}</span></>}
      </div>
      <div className="page-head"><h1>{title}</h1>{data && <span className="count-badge">{data.total}</span>}</div>
      <form
        className="search-box card"
        onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() }); }}
      >
        <div className="search-row">
          <input
            className="input input-lg"
            placeholder="Поиск: название, номер, слова из текста…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn btn-primary btn-lg">Найти</button>
        </div>
        <div className="filters">
          <div className="segmented" role="radiogroup" aria-label="Где искать">
            {[['all', 'Везде'], ['title', 'В названии'], ['content', 'В тексте']].map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={mode === v ? 'active' : ''}
                onClick={() => update({ mode: v === 'all' ? '' : v })}
              >
                {label}
              </button>
            ))}
          </div>
          <select className="input input-sm" value={type} onChange={(e) => update({ type: e.target.value })}>
            <option value="">Все виды</option>
            {Object.entries(docTypes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input input-sm" value={folder} onChange={(e) => update({ folder: e.target.value })}>
            <option value="">{restrictedFolders ? 'Все доступные папки' : 'Все папки'}</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{'\u00A0\u00A0'.repeat(f.level) + f.name}</option>)}
            {!restrictedFolders && <option value="0">Без папки</option>}
          </select>
          <select className="input input-sm" value={tag} onChange={(e) => update({ tag: e.target.value })}>
            <option value="">Все теги</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="input input-sm" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Любой статус</option>
            {Object.entries(DOC_STATUSES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input input-sm" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="">{q ? 'По релевантности' : 'Сначала изменённые'}</option>
            <option value="updated">Сначала изменённые</option>
            <option value="adopted">По дате принятия</option>
            <option value="title">По названию</option>
          </select>
        </div>
        <p className="hint">
          Поиск учитывает формы слов. Точная фраза — в кавычках: «"электронный документ"». Исключить слово — минусом: «-проект».
        </p>
      </form>

      <div className="results-head">
        <span className="muted">
          {loading ? 'Поиск…' : data ? `Найдено документов: ${data.total}` : ''}
        </span>
        {canEdit(user) && <Link to={`/documents/new${curFolder ? `?folder=${curFolder.id}` : ''}`} className="btn btn-primary">+ Добавить документ{curFolder ? ' в эту папку' : ''}</Link>}
      </div>

      {error && <div className="alert">{error}</div>}

      {data && !data.items.length && !loading && (
        <div className="empty card">
          {q ? 'По вашему запросу ничего не найдено. Попробуйте изменить формулировку или фильтры.' : 'В базе пока нет документов.'}
        </div>
      )}

      <ul className="results">
        {data?.items.map((d) => (
          <li key={d.id} className="card result">
            <div className="result-meta">
              <TypeBadge code={d.doc_type} />
              {d.number && <span>№ {d.number}</span>}
              {d.adopted_at && <span>от {formatDate(d.adopted_at)}</span>}
              <span className={`status status-${d.status}`}>{DOC_STATUSES[d.status]}</span>
              {d.folder_id && folderMap[d.folder_id] && (
                <Link to={`/?folder=${d.folder_id}`} className="folder-path">📁 {folderMap[d.folder_id].path}</Link>
              )}
              <TagList tags={d.tags} />
            </div>
            <Link to={`/documents/${d.id}`} className="result-title">{d.title}</Link>
            <Snippet text={d.snippet} />
          </li>
        ))}
      </ul>

      {data && (
        <Pagination
          page={page}
          total={data.total}
          limit={LIMIT}
          onChange={(p) => { update({ page: String(p) }); window.scrollTo(0, 0); }}
        />
      )}
    </div>
  );
}
