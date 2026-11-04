import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { DOC_STATUSES } from '../constants.js';
import MarkdownView from '../components/MarkdownView.jsx';
import DocLinkPicker from '../components/DocLinkPicker.jsx';

const EMPTY = { title: '', doc_type: 'law', number: '', adopted_at: '', status: 'active', content: '' };

export default function DocumentEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const taRef = useRef(null);

  const { docTypes } = useAuth();
  const [form, setForm] = useState(() => ({ ...EMPTY, doc_type: docTypes.law ? 'law' : Object.keys(docTypes)[0] || 'other' }));
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState('');
  const [existingFile, setExistingFile] = useState(null);
  const [file, setFile] = useState(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('edit');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    api(`/documents/${id}`)
      .then((d) => {
        setForm({
          title: d.title, doc_type: d.doc_type, number: d.number,
          adopted_at: d.adopted_at || '', status: d.status, content: d.content,
        });
        setExpectedUpdatedAt(d.updated_at);
        setExistingFile(d.file_name);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /** Заменяет выделение в редакторе: before + (выделение|placeholder) + after */
  function wrapSelection(before, after = '', placeholder = '') {
    const ta = taRef.current;
    const { selectionStart: s, selectionEnd: e } = ta;
    const selected = form.content.slice(s, e) || placeholder;
    const content = form.content.slice(0, s) + before + selected + after + form.content.slice(e);
    setForm((f) => ({ ...f, content }));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + selected.length);
    });
  }

  function insertLink(doc) {
    const ta = taRef.current;
    const { selectionStart: s, selectionEnd: e } = ta;
    const label = (form.content.slice(s, e) || doc.title).replace(/[[\]]/g, '');
    const link = `[${label}](doc:${doc.id})`;
    setForm((f) => ({ ...f, content: f.content.slice(0, s) + link + f.content.slice(e) }));
    setPickerOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + link.length, s + link.length);
    });
  }

  async function onFileChange(e) {
    const f = e.target.files[0] || null;
    setFile(f);
    setRemoveFile(false);
    if (!f) return;
    if (form.content.trim() && !window.confirm('Заменить текущий текст документа текстом из файла?')) return;
    setExtracting(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const { text } = await api('/documents/extract', { method: 'POST', form: fd });
      setForm((prev) => ({
        ...prev,
        content: text,
        title: prev.title || f.name.replace(/\.[^.]+$/, ''),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (file) fd.append('file', file);
      if (removeFile) fd.append('remove_file', '1');
      if (!isNew) fd.append('expected_updated_at', expectedUpdatedAt);
      const r = await api(isNew ? '/documents' : `/documents/${id}`, {
        method: isNew ? 'POST' : 'PUT',
        form: fd,
      });
      navigate(`/documents/${r.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  if (loading) return <p className="muted center">Загрузка…</p>;

  return (
    <form className="card edit-form" onSubmit={submit}>
      <h1>{isNew ? 'Новый документ' : 'Редактирование документа'}</h1>
      {error && <div className="alert">{error}</div>}

      <label className="field">
        <span>Название *</span>
        <input className="input" value={form.title} onChange={set('title')} required />
      </label>

      <div className="grid-4">
        <label className="field">
          <span>Вид документа</span>
          <select className="input" value={form.doc_type} onChange={set('doc_type')}>
            {Object.entries(docTypes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Номер</span>
          <input className="input" value={form.number} onChange={set('number')} placeholder="напр. 149-ФЗ" />
        </label>
        <label className="field">
          <span>Дата принятия</span>
          <input className="input" type="date" value={form.adopted_at} onChange={set('adopted_at')} />
        </label>
        <label className="field">
          <span>Статус</span>
          <select className="input" value={form.status} onChange={set('status')}>
            {Object.entries(DOC_STATUSES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      <div className="field">
        <span>Файл документа (PDF, DOCX, TXT, MD — до 50 МБ)</span>
        <div className="file-row">
          <input type="file" accept=".pdf,.docx,.txt,.md" onChange={onFileChange} />
          {extracting && <span className="muted">Извлечение текста…</span>}
          {!file && existingFile && !removeFile && (
            <span className="muted">
              Текущий файл: {existingFile}{' '}
              <button type="button" className="link-btn" onClick={() => setRemoveFile(true)}>удалить</button>
            </span>
          )}
          {removeFile && (
            <span className="muted">
              Файл будет удалён{' '}
              <button type="button" className="link-btn" onClick={() => setRemoveFile(false)}>отменить</button>
            </span>
          )}
        </div>
        <p className="hint">Текст из файла подставится в поле ниже — его можно проверить и поправить перед сохранением.</p>
      </div>

      <div className="field">
        <div className="editor-head">
          <div className="tabs">
            <button type="button" className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>Текст</button>
            <button type="button" className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Предпросмотр</button>
          </div>
          {tab === 'edit' && (
            <div className="toolbar">
              <button type="button" title="Заголовок" onClick={() => wrapSelection('\n## ', '\n', 'Заголовок')}>H</button>
              <button type="button" title="Жирный" onClick={() => wrapSelection('**', '**', 'текст')}><b>Ж</b></button>
              <button type="button" title="Курсив" onClick={() => wrapSelection('*', '*', 'текст')}><i>К</i></button>
              <button type="button" title="Список" onClick={() => wrapSelection('\n- ', '', 'пункт')}>• Список</button>
              <button type="button" className="toolbar-accent" onClick={() => setPickerOpen(true)}>
                🔗 Ссылка на документ
              </button>
            </div>
          )}
        </div>
        {tab === 'edit' ? (
          <textarea
            ref={taRef}
            className="input editor"
            value={form.content}
            onChange={set('content')}
            placeholder="Текст документа. Поддерживается Markdown: ## заголовок, **жирный**, - список."
          />
        ) : (
          <div className="preview"><MarkdownView content={form.content} /></div>
        )}
      </div>

      <div className="form-actions">
        <button className="btn btn-primary" disabled={saving || extracting}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <Link to={isNew ? '/' : `/documents/${id}`} className="btn btn-ghost">Отмена</Link>
      </div>

      {pickerOpen && (
        <DocLinkPicker excludeId={id} onPick={insertLink} onClose={() => setPickerOpen(false)} />
      )}
    </form>
  );
}
