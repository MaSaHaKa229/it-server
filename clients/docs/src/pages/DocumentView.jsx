import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  DOC_STATUSES, canEdit, formatDate, formatDateTime, formatSize,
} from '../constants.js';
import MarkdownView from '../components/MarkdownView.jsx';
import Modal from '../components/Modal.jsx';
import TypeBadge from '../components/TypeBadge.jsx';

function DocList({ title, items, empty }) {
  const { typeName } = useAuth();
  return (
    <section className="side-block">
      <h4>{title}</h4>
      {items.length ? (
        <ul className="side-list">
          {items.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`}>{d.title}</Link>
              <span className="muted small"> {typeName(d.doc_type)}{d.number ? ` № ${d.number}` : ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </section>
  );
}

export default function DocumentView() {
  const { id } = useParams();
  const { user, reloadTypes } = useAuth();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [versions, setVersions] = useState(null);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    setDoc(null);
    setVersions(null);
    setError('');
    api(`/documents/${id}`).then(setDoc).catch((e) => setError(e.message));
  }, [id]);

  // Сам документ считается «существующим» для ссылок на себя
  const knownLinks = useMemo(
    () => (doc ? [...doc.links, { id: doc.id, title: doc.title }] : null),
    [doc]
  );

  async function remove() {
    if (!window.confirm(`Удалить документ «${doc.title}»? Действие необратимо.`)) return;
    try {
      await api(`/documents/${id}`, { method: 'DELETE' });
      reloadTypes();
      navigate('/');
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadVersions() {
    if (versions) return;
    try {
      setVersions((await api(`/documents/${id}/versions`)).items);
    } catch (e) {
      alert(e.message);
    }
  }

  async function openVersion(vid) {
    try {
      setVersion(await api(`/documents/${id}/versions/${vid}`));
    } catch (e) {
      alert(e.message);
    }
  }

  if (error) return <div className="alert">{error}</div>;
  if (!doc) return <p className="muted center">Загрузка…</p>;

  return (
    <div>
      <button className="btn btn-ghost btn-sm back" onClick={() => navigate(-1)}>← Назад</button>

      <div className="doc-layout">
        <article className="card doc-main">
          <div className="result-meta">
            <TypeBadge code={doc.doc_type} />
            {doc.number && <span>№ {doc.number}</span>}
            {doc.adopted_at && <span>от {formatDate(doc.adopted_at)}</span>}
            <span className={`status status-${doc.status}`}>{DOC_STATUSES[doc.status]}</span>
          </div>
          <h1 className="doc-title">{doc.title}</h1>

          <div className="doc-actions">
            {doc.file_name && (
              <button
                className="btn"
                onClick={() => downloadFile(`/documents/${id}/file`, doc.file_name).catch((e) => alert(e.message))}
              >
                ⬇ Оригинал ({formatSize(doc.file_size)})
              </button>
            )}
            {canEdit(user) && (
              <>
                <Link to={`/documents/${id}/edit`} className="btn btn-primary">Редактировать</Link>
                <button className="btn btn-danger" onClick={remove}>Удалить</button>
              </>
            )}
          </div>

          <MarkdownView content={doc.content} links={knownLinks} />
        </article>

        <aside className="doc-side">
          <section className="side-block card">
            <h4>Сведения</h4>
            <dl className="info">
              <dt>Добавлен</dt>
              <dd>{formatDateTime(doc.created_at)}{doc.created_by_name && `, ${doc.created_by_name}`}</dd>
              <dt>Изменён</dt>
              <dd>{formatDateTime(doc.updated_at)}{doc.updated_by_name && `, ${doc.updated_by_name}`}</dd>
            </dl>
          </section>
          <div className="card">
            <DocList title="Ссылается на" items={doc.links} empty="Нет ссылок на другие документы" />
            <DocList title="На документ ссылаются" items={doc.backlinks} empty="Пока никто не ссылается" />
          </div>
          <details className="card side-block" onToggle={(e) => e.currentTarget.open && loadVersions()}>
            <summary>История изменений</summary>
            {!versions && <p className="muted small">Загрузка…</p>}
            {versions && !versions.length && <p className="muted small">Документ ещё не редактировался</p>}
            {versions && versions.length > 0 && (
              <ul className="side-list">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button className="link-btn" onClick={() => openVersion(v.id)}>
                      {formatDateTime(v.edited_at)}
                    </button>
                    <span className="muted small"> {v.edited_by_name || '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </aside>
      </div>

      {version && (
        <Modal
          wide
          title={`Версия от ${formatDateTime(version.edited_at)}${version.edited_by_name ? ` (${version.edited_by_name})` : ''}`}
          onClose={() => setVersion(null)}
        >
          <h2 className="doc-title">{version.title}</h2>
          <MarkdownView content={version.content} />
        </Modal>
      )}
    </div>
  );
}
