import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { DOC_STATUSES } from '../constants.js';

/** Боковая панель как в ИТ-инвентаре: папки (дерево), теги, виды документов */
export default function Sidebar({ open }) {
  const { types, folders, unfiled, restrictedFolders, tags } = useAuth();
  const loc = useLocation();
  const cur = loc.pathname + loc.search;
  const total = types.reduce((s, t) => s + t.count, 0);
  const link = (to, content, count, style) => (
    <Link key={to} to={to} className={`side-link ${cur === to ? 'active' : ''}`} style={style} title={typeof content === 'string' ? content : undefined}>
      {content}{count != null && <span className="count">{count}</span>}
    </Link>
  );
  const usedTags = tags.filter((t) => t.count > 0);
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-project">
        <div className="icon">§</div>
        <div><div className="name">Документы</div><div className="sub">Реестр нормативных документов</div></div>
      </div>
      {link('/', 'Все документы', total)}
      <div className="side-section">
        <h4>Папки{restrictedFolders && <span className="side-note"> · доступные вам</span>}</h4>
        {folders.map((f) => link(`/?folder=${f.id}`,
          <><span className="folder-ico">📁</span><span className="side-text">{f.name}</span></>, f.total,
          { paddingLeft: 8 + f.level * 16 }))}
        {!folders.length && <div className="side-empty">{restrictedFolders ? 'Вам не выдан доступ ни к одной папке' : 'Папок пока нет'}</div>}
        {unfiled != null && unfiled > 0 && link('/?folder=0', <><span className="folder-ico">🗀</span><span className="side-text muted">Без папки</span></>, unfiled)}
      </div>
      {usedTags.length > 0 && (
        <div className="side-section">
          <h4>Теги</h4>
          <div className="side-tags">
            {usedTags.map((t) => (
              <Link key={t.id} to={`/?tag=${t.id}`} className={`tag ${cur === `/?tag=${t.id}` ? 'on' : ''}`} style={{ '--tag': t.color }}>
                {t.name}<span className="tag-n">{t.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="side-section">
        <h4>Виды документов</h4>
        {types.filter((t) => t.count > 0).map((t) => link(`/?type=${t.code}`, <><span className="type-dot" style={{ background: t.color }} />{t.name}</>, t.count))}
      </div>
      <div className="side-section">
        <h4>Статус</h4>
        {Object.entries(DOC_STATUSES).map(([k, l]) => link(`/?status=${k}`, l))}
      </div>
    </aside>
  );
}
