import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { DOC_STATUSES } from '../constants.js';

/** Боковая панель как в ИТ-инвентаре: виды документов с количеством */
export default function Sidebar({ open }) {
  const { types } = useAuth();
  const loc = useLocation();
  const cur = loc.pathname + loc.search;
  const total = types.reduce((s, t) => s + t.count, 0);
  const link = (to, content, count) => (
    <Link to={to} className={`side-link ${cur === to ? 'active' : ''}`}>{content}{count != null && <span className="count">{count}</span>}</Link>
  );
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-project">
        <div className="icon">§</div>
        <div><div className="name">Документы</div><div className="sub">Реестр нормативных документов</div></div>
      </div>
      {link('/', 'Все документы', total)}
      <div className="side-section">
        <h4>Виды документов</h4>
        {types.map((t) => link(`/?type=${t.code}`, <><span className="type-dot" style={{ background: t.color }} />{t.name}</>, t.count))}
      </div>
      <div className="side-section">
        <h4>Статус</h4>
        {Object.entries(DOC_STATUSES).map(([k, l]) => link(`/?status=${k}`, l))}
      </div>
    </aside>
  );
}
