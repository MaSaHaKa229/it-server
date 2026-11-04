import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { DOC_STATUSES, DOC_TYPES, canEdit, formatDate } from '../constants.js';
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
  const { user, docTypes } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const mode = params.get('mode') || 'all';
  const type = params.get('type') || '';
  const status = params.get('status') || '';
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
    if (sort) query.set('sort', sort);
    api(`/documents?${query}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [q, mode, type, status, sort, page]);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  }

  return (
    <div>
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
        {canEdit(user) && <Link to="/documents/new" className="btn btn-primary">+ Добавить документ</Link>}
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
              <span className={`badge type-${d.doc_type}`}>{DOC_TYPES[d.doc_type]}</span>
              {d.number && <span>№ {d.number}</span>}
              {d.adopted_at && <span>от {formatDate(d.adopted_at)}</span>}
              <span className={`status status-${d.status}`}>{DOC_STATUSES[d.status]}</span>
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
