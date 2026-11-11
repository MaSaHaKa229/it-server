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
import { TagList } from '../components/Tags.jsx';

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

// «1, 2, 3, 5» → «1–3, 5»
function pageRanges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** Сведения о сканированных страницах и их распознавании */
function OcrNote({ doc, canRetry, onRetry }) {
  const s = doc.ocr_status;
  const scan = doc.file_pages > 0 && doc.file_text_pages < doc.file_pages;
  if (s === 'pending' || s === 'running') {
    const p = doc.ocr_progress;
    return (
      <div className="alert alert-info ocr-note">
        <span className="ocr-spin" />
        {p ? `Распознаётся текст сканированных страниц: ${p.page} из ${p.total}…` : 'Документ в очереди на распознавание текста…'}
        {' '}Текст появится здесь сам.
      </div>
    );
  }
  if (s === 'done' && doc.ocr_pages?.length) {
    return (
      <div className="alert alert-info">
        Текст стр. {pageRanges(doc.ocr_pages)} распознан автоматически со скана — возможны ошибки; их можно исправить в редакторе.
        Весь документ целиком — кнопка «Открыть оригинал».
      </div>
    );
  }
  if (s === 'error' || s === 'unavailable' || (s === 'done' && !doc.ocr_pages?.length && scan)) {
    return (
      <div className="alert alert-warn">
        {s === 'unavailable' ? `Распознавание текста недоступно: ${doc.ocr_error}. ` : `Не удалось распознать текст сканированных страниц: ${doc.ocr_error || 'ошибка'}. `}
        {canRetry && s !== 'done' && <button className="btn btn-small" onClick={onRetry}>Повторить распознавание</button>}
      </div>
    );
  }
  if (scan) {
    return (
      <div className="alert alert-warn">
        {doc.file_text_pages === 0
          ? `Файл — скан (${doc.file_pages} стр. без текста). `
          : `Текст получен с ${doc.file_text_pages} из ${doc.file_pages} стр. файла — остальные страницы являются сканами. `}
        Весь документ целиком — кнопка «Открыть оригинал».
        {canRetry && <> <button className="btn btn-small" onClick={onRetry}>Распознать текст</button></>}
      </div>
    );
  }
  return null;
}

export default function DocumentView() {
  const { id } = useParams();
  const { user, reloadTypes, folderMap } = useAuth();
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

  // Пока идёт распознавание сканов — обновляем документ раз в 3 секунды
  const ocrBusy = doc && ['pending', 'running'].includes(doc.ocr_status);
  useEffect(() => {
    if (!ocrBusy) return undefined;
    const t = setTimeout(() => {
      api(`/documents/${id}`).then((d) => { setDoc(d); if (!['pending', 'running'].includes(d.ocr_status)) setVersions(null); }).catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, [doc, ocrBusy, id]);

  async function retryOcr() {
    try {
      await api(`/documents/${id}/ocr`, { method: 'POST' });
      setDoc(await api(`/documents/${id}`));
    } catch (e) {
      alert(e.message);
    }
  }

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
      <div className="breadcrumbs">
        <a href="/">ИТ-портал</a><span className="sep">/</span><Link to="/">Документы</Link>
        {doc.folder_id && folderMap[doc.folder_id] && (
          <><span className="sep">/</span><Link to={`/?folder=${doc.folder_id}`}>📁 {folderMap[doc.folder_id].path}</Link></>
        )}
      </div>

      <div className="doc-layout">
        <article className="card doc-main">
          <div className="result-meta">
            <TypeBadge code={doc.doc_type} />
            {doc.number && <span>№ {doc.number}</span>}
            {doc.adopted_at && <span>от {formatDate(doc.adopted_at)}</span>}
            <span className={`status status-${doc.status}`}>{DOC_STATUSES[doc.status]}</span>
            <TagList tags={doc.tags} />
          </div>
          <h1 className="doc-title">{doc.title}</h1>

          <div className="doc-actions">
            {doc.file_name && /\.(pdf|txt|md)$/i.test(doc.file_name) && (
              <a className="btn btn-primary" href={`/docs/api/documents/${id}/file?inline=1`} target="_blank" rel="noopener">
                Открыть оригинал{doc.file_pages ? ` (${doc.file_pages} стр.)` : ''}
              </a>
            )}
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
                <Link to={`/documents/${id}/edit`} className="btn">Редактировать</Link>
                <button className="btn btn-danger" onClick={remove}>Удалить</button>
              </>
            )}
          </div>

          <OcrNote doc={doc} canRetry={canEdit(user)} onRetry={retryOcr} />
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
