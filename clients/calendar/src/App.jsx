import { useEffect, useState } from 'react';
import { api, logoutPortal } from './api.js';
import { AppProvider, useApp } from './context.jsx';
import { initials } from './constants.js';
import { ROLES } from './constants.js';
import CalendarPage from './pages/CalendarPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CategoriesPage from './pages/CategoriesPage.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import Icon from './components/Icon.jsx';

// Простая навигация по hash (#/calendar, #/users, ...) — без внешнего роутера
function useHashRoute() {
  // #/calendar?task=12 — открыть задачу по ссылке (например, из заявки helpdesk)
  const get = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'calendar';
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/auth/me').then((d) => setUser(d.user)).catch((e) => { setError(e.message); setUser(null); });
  }, []);

  if (user === undefined) return <div className="splash"><div className="spinner" /></div>;
  if (!user) return <div className="splash"><p>{error || 'Требуется вход'} · <a href="/">На главную</a></p></div>;
  return (
    <AppProvider user={user} setUser={setUser}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const route = useHashRoute();
  const { user, canEdit } = useApp();
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = [
    { id: 'calendar', label: 'Календарь', icon: 'calendar' },
    { id: 'dashboard', label: 'Обзор', icon: 'chart' },
    canEdit && { id: 'categories', label: 'Категории', icon: 'tag' },
    canEdit && { id: 'activity', label: 'Журнал', icon: 'clock' },
  ].filter(Boolean);

  const page = {
    calendar: <CalendarPage />,
    dashboard: <Dashboard />,
    categories: canEdit ? <CategoriesPage /> : null,
    activity: canEdit ? <ActivityPage /> : null,
    profile: <ProfilePage />,
  }[route] ?? <CalendarPage />;

  const logout = logoutPortal;

  useEffect(() => setMenuOpen(false), [route]);

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Icon name="calendar" /></div>
          <div>
            <div className="brand-title">Календарь</div>
            <div className="brand-sub">задач отдела</div>
          </div>
        </div>
        <nav>
          <a href="/" title="Главная страница портала"><Icon name="menu" /> Портал</a>
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={route === n.id ? 'active' : ''}>
              <Icon name={n.icon} /> {n.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <a href="#/profile" className={`me ${route === 'profile' ? 'active' : ''}`}>
            <span className="avatar" style={{ background: user.color }}>{initials(user.name)}</span>
            <span className="me-text">
              <b>{user.name}</b>
              <small>{ROLES[user.role].label}</small>
            </span>
          </a>
          <div className="sidebar-actions">
            <button className="icon-btn" onClick={toggleTheme} title="Сменить тему">
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </button>
            <button className="icon-btn" onClick={logout} title="Выйти"><Icon name="logout" /></button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}
      <main className="main">
        <button className="icon-btn burger" onClick={() => setMenuOpen(true)} aria-label="Меню"><Icon name="menu" /></button>
        {page}
      </main>
    </div>
  );
}
