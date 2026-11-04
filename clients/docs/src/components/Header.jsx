import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ROLES, canEdit } from '../constants.js';

export default function Header() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <header className="header">
      <div className="container header-inner">
        <a href="/" className="brand portal-link" title="Главная страница портала">⌂ Портал</a>
        <Link to="/" className="brand">
          <span className="brand-mark">§</span> Реестр документов
        </Link>
        <nav className="nav">
          <NavLink to="/" end>Поиск</NavLink>
          {canEdit(user) && <NavLink to="/documents/new">Добавить</NavLink>}
        </nav>
        <div className="header-user">
          <Link to="/profile" className="user-link" title="Профиль">
            {user.full_name || user.username}
            <span className={`badge role-${user.role}`}>{ROLES[user.role]}</span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Выйти</button>
        </div>
      </div>
    </header>
  );
}
