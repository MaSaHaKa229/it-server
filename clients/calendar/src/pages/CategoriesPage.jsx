import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { PALETTE } from '../constants.js';
import Icon from '../components/Icon.jsx';

export default function CategoriesPage() {
  const { categories, reloadCategories, isAdmin, toast } = useApp();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[1]);

  const run = async (fn, msg) => { try { await fn(); toast(msg); reloadCategories(); } catch (e) { toast(e.message, 'err'); } };
  const add = (e) => { e.preventDefault(); run(async () => { await api.post('/categories', { name, color }); setName(''); }, 'Категория добавлена'); };
  const rename = (c) => { const n = prompt('Новое название', c.name); if (n && n !== c.name) run(() => api.patch(`/categories/${c.id}`, { name: n }), 'Сохранено'); };
  const recolor = (c, col) => run(() => api.patch(`/categories/${c.id}`, { color: col }), 'Цвет изменён');
  const remove = (c) => { if (confirm(`Удалить категорию «${c.name}»? Задачи останутся без категории.`)) run(() => api.del(`/categories/${c.id}`), 'Категория удалена'); };

  return (
    <div className="page narrow">
      <header className="page-head"><h2>Категории задач</h2><p className="muted">Цвет категории определяет цвет задачи в календаре</p></header>
      <form className="card cat-form" onSubmit={add}>
        <input placeholder="Название новой категории" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        <div className="swatches">
          {PALETTE.map((c) => <button type="button" key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <button className="btn primary"><Icon name="plus" /> Добавить</button>
      </form>
      <div className="card flush">
        {categories.map((c) => (
          <div key={c.id} className="cat-row">
            <label className="swatch-input" style={{ background: c.color }} title="Сменить цвет">
              <input type="color" value={c.color} onChange={(e) => recolor(c, e.target.value)} />
            </label>
            <b>{c.name}</b>
            <span className="muted small">{c.task_count} задач</span>
            <button className="icon-btn" onClick={() => rename(c)} title="Переименовать"><Icon name="edit" /></button>
            {isAdmin && <button className="icon-btn" onClick={() => remove(c)} title="Удалить"><Icon name="trash" /></button>}
          </div>
        ))}
        {!categories.length && <p className="muted pad">Категорий пока нет</p>}
      </div>
    </div>
  );
}
