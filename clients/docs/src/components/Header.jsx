import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ROLES, canEdit } from '../constants.js';

const AV = ['#0052CC', '#00875A', '#FF5630', '#6554C0', '#00A3BF', '#FF8B00', '#36B37E', '#5243AA'];
export function Avatar({ name, small }) {
  const n = String(name || '?');
  let sum = 0; for (const ch of n) sum += ch.charCodeAt(0);
  const ini = n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  return <span className={`avatar ${small ? 'sm' : ''}`} style={{ background: AV[sum % AV.length] }} title={n}>{ini || '?'}</span>;
}

// Разделы портала для меню пользователя
function sections(p) {
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

const BELL_URL = ['', 'shared', 'bell.js'].join('/');
// Колокольчик уведомлений портала (общий модуль /shared/bell.js)
function Bell() {
  const ref = useRef(null);
  useEffect(() => {
    let off = null;
    import(/* @vite-ignore */ BELL_URL).then((m) => { if (ref.current) off = m.mountBell(ref.current); }).catch(() => {});
    return () => off?.();
  }, []);
  return <span ref={ref} />;
}

/** Шапка в стиле ИТ-инвентаря */
export default function Header({ onBurger }) {
  const { user, portal, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const folder = new URLSearchParams(useLocation().search).get('folder');
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  if (!user) return null;
  const name = user.full_name || user.username;

  return (
    <header className="topbar">
      <button className="btn btn-ghost burger" onClick={onBurger} aria-label="Меню">☰</button>
      <a href="/" className="brand" title="Главная страница портала"><span className="brand-logo">IT</span><span>Портал</span></a>
      <Link to="/" className="brand" style={{ marginLeft: -12 }}><span className="sep">/</span><span>Документы</span></Link>
      <nav className="topnav">
        <NavLink to="/" end>Поиск</NavLink>
        {canEdit(user) && <NavLink to="/folders">Папки и теги</NavLink>}
        {canEdit(user) && <NavLink to="/types">Виды документов</NavLink>}
      </nav>
      {canEdit(user) && <Link to={`/documents/new${folder && folder !== '0' ? `?folder=${folder}` : ''}`} className="btn btn-primary" style={{ marginLeft: 8 }}>+ Добавить</Link>}
      <span className="spacer" />
      {portal?.access?.inventory && portal.access.inventory !== 'none' && <Bell />}
      <span className="user-name">{name}</span>
      <span className="user-wrap" ref={ref}>
        <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-label="Меню пользователя"><Avatar name={name} /></button>
        {open && (
          <div className="popover">
            <div className="menu-head">{name} · {ROLES[user.role]}</div>
            <div className="menu-head">Разделы</div>
            {sections(portal).map(([href, label]) => <a key={href} className="menu-item" href={href}>{label}</a>)}
            <div className="menu-sep" />
            <Link className="menu-item" to="/profile" onClick={() => setOpen(false)}>Профиль и пароль</Link>
            <button className="menu-item" onClick={logout}>Выйти</button>
          </div>
        )}
      </span>
    </header>
  );
}
