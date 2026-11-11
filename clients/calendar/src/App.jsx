import { useEffect, useRef, useState } from 'react';
import { api, logoutPortal } from './api.js';
import { AppProvider, useApp } from './context.jsx';
import { initials } from './constants.js';
import { ROLES } from './constants.js';
import CalendarPage from './pages/CalendarPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CategoriesPage from './pages/CategoriesPage.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import StatsPage from './pages/StatsPage.jsx';
import AbsencesPage from './pages/AbsencesPage.jsx';
import SeriesPage from './pages/SeriesPage.jsx';
import ColorsPage from './pages/ColorsPage.jsx';

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

// Разделы портала для меню пользователя
function portalSections(p) {
  if (!p) return [];
  const a = p.access || {};
  return [
    ['/', 'Главная'],
    a.inventory !== 'none' && ['/inventory/', 'ИТ-инвентарь'],
    a.docs !== 'none' && ['/docs/', 'Документы'],
    a.calendar !== 'none' && ['/calendar/', 'Задачи'],
    a.helpdesk !== 'none' && ['/helpdesk/', 'Заявки'],
    p.user?.isAdmin && ['/admin', 'Администрирование'],
  ].filter(Boolean);
}
const AV = ['#0052CC', '#00875A', '#FF5630', '#6554C0', '#00A3BF', '#FF8B00', '#36B37E', '#5243AA'];
const avColor = (n) => { let s = 0; for (const ch of String(n)) s += ch.charCodeAt(0); return AV[s % AV.length]; };

const BELL_URL = ['', 'shared', 'bell.js'].join('/');
// Колокольчик уведомлений портала (общий модуль /shared/bell.js)
function Bell() {
  const ref = useRef(null);
  useEffect(() => {
    let off = null;
    import(/* @vite-ignore */ BELL_URL).then((m) => { if (ref.current) off = m.mountHeaderTools(ref.current); }).catch(() => {});
    return () => off?.();
  }, []);
  return <span ref={ref} style={{ display: 'inline-flex', alignItems: 'center' }} />;
}

function Shell() {
  const route = useHashRoute();
  const { user, canEdit, isAdmin } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [portal, setPortal] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then(setPortal).catch(() => {});
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  useEffect(() => setMenuOpen(false), [route]);

  const nav = [
    { id: 'calendar', label: 'Календарь' },
    { id: 'dashboard', label: 'Обзор' },
    { id: 'absences', label: 'Отпуска' },
    { id: 'series', label: 'Регулярные' },
    canEdit && { id: 'categories', label: 'Категории' },
    canEdit && { id: 'activity', label: 'Журнал' },
    { id: 'colors', label: 'Цвета' },
    isAdmin && { id: 'stats', label: 'Статистика' },
  ].filter(Boolean);

  const page = {
    calendar: <CalendarPage />,
    dashboard: <Dashboard />,
    absences: <AbsencesPage />,
    series: <SeriesPage />,
    categories: canEdit ? <CategoriesPage /> : null,
    activity: canEdit ? <ActivityPage /> : null,
    stats: isAdmin ? <StatsPage /> : null,
    profile: <ProfilePage />,
    colors: <ColorsPage />,
  }[route] ?? <CalendarPage />;

  return (
    <>
      <header className="topbar">
        <a href="/" className="brand" title="Главная страница портала"><span className="brand-logo">IT</span><span>Портал</span></a>
        <a href="#/calendar" className="brand" style={{ marginLeft: -12 }}><span className="sep">/</span><span>Задачи</span></a>
        <nav className="topnav">
          {nav.map((n) => <a key={n.id} href={`#/${n.id}`} className={route === n.id ? 'active' : ''}>{n.label}</a>)}
        </nav>
        <span className="spacer" />
        <Bell />
        <span className="user-name">{user.name}</span>
        <span className="user-wrap" ref={menuRef}>
          <button className="avatar-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Меню пользователя">
            <span className="avatar" style={{ background: avColor(user.name) }}>{initials(user.name)}</span>
          </button>
          {menuOpen && (
            <div className="popover">
              <div className="menu-head">{user.name} · {ROLES[user.role].label}</div>
              <div className="menu-head">Разделы</div>
              {portalSections(portal).map(([href, label]) => <a key={href} className="menu-item" href={href}>{label}</a>)}
              <div className="menu-sep" />
              <a className="menu-item" href="#/profile">Профиль, цвет и пароль</a>
              <button className="menu-item" onClick={logoutPortal}>Выйти</button>
            </div>
          )}
        </span>
      </header>
      <main className="app-main">{page}</main>
    </>
  );
}
