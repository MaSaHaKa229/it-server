import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

/** Плашки тегов документа; link — ведут на отбор по тегу */
export function TagList({ tags, link = true }) {
  if (!tags?.length) return null;
  return (
    <span className="tags">
      {tags.map((t) => (link
        ? <Link key={t.id} to={`/?tag=${t.id}`} className="tag" style={{ '--tag': t.color }}>{t.name}</Link>
        : <span key={t.id} className="tag" style={{ '--tag': t.color }}>{t.name}</span>))}
    </span>
  );
}

/** Редактор тегов: выбранные плашки + поле ввода с подсказками; новый тег создаётся при сохранении */
export function TagEditor({ value, onChange }) {
  const { tags } = useAuth();
  const [text, setText] = useState('');
  const has = (name) => value.some((v) => v.toLowerCase() === name.toLowerCase());
  const add = (name) => {
    const n = name.trim().replace(/,+$/, '').slice(0, 60);
    if (n && !has(n)) onChange([...value, n]);
    setText('');
  };
  const color = (name) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.color || '#6B778C';
  const suggestions = tags.filter((t) => !has(t.name) && (!text || t.name.toLowerCase().includes(text.toLowerCase()))).slice(0, 12);
  return (
    <div className="tag-editor">
      <div className="tags">
        {value.map((name) => (
          <span key={name} className="tag" style={{ '--tag': color(name) }}>
            {name}
            <button type="button" className="tag-x" onClick={() => onChange(value.filter((v) => v !== name))} aria-label={`Убрать тег ${name}`}>×</button>
          </span>
        ))}
        <input
          className="tag-input"
          value={text}
          placeholder={value.length ? 'ещё тег…' : 'Введите тег и нажмите Enter'}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(text); }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="tag-suggest">
          <span className="muted small">Есть в базе:</span>
          {suggestions.map((t) => (
            <button type="button" key={t.id} className="tag ghost" style={{ '--tag': t.color }} onMouseDown={(e) => { e.preventDefault(); add(t.name); }}>+ {t.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}
