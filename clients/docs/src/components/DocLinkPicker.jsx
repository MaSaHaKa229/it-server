import { useEffect, useState } from 'react';
import { api } from '../api.js';
import TypeBadge from './TypeBadge.jsx';
import Modal from './Modal.jsx';

/** Окно выбора документа из базы для вставки ссылки */
export default function DocLinkPicker({ onPick, onClose, excludeId }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ mode: 'title', limit: '15' });
        if (q.trim()) params.set('q', q.trim());
        else params.set('sort', 'updated');
        const d = await api(`/documents?${params}`);
        if (!cancelled) setItems(d.items.filter((i) => i.id !== Number(excludeId)));
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, excludeId]);

  return (
    <Modal title="Ссылка на документ из базы" onClose={onClose}>
      <input
        className="input"
        autoFocus
        placeholder="Название или номер документа…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <p className="hint">
        Если в тексте выделен фрагмент, он станет текстом ссылки. Иначе будет вставлено название документа.
      </p>
      <ul className="picker-list">
        {loading && !items.length && <li className="muted">Поиск…</li>}
        {!loading && !items.length && <li className="muted">Ничего не найдено</li>}
        {items.map((d) => (
          <li key={d.id}>
            <button type="button" className="picker-item" onClick={() => onPick(d)}>
              <TypeBadge code={d.doc_type} />
              <span className="picker-title">{d.title}</span>
              {d.number && <span className="muted"> № {d.number}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
