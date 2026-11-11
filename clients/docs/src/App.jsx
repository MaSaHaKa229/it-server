import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { EDITOR_ROLES } from './constants.js';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import Search from './pages/Search.jsx';
import DocumentView from './pages/DocumentView.jsx';
import DocumentEdit from './pages/DocumentEdit.jsx';
import DocTypes from './pages/DocTypes.jsx';
import Profile from './pages/Profile.jsx';

function RequireAuth({ roles, children }) {
  const { user, loading, error } = useAuth();
  if (loading) return <p className="muted center">Загрузка…</p>;
  if (!user) return <div className="alert">{error || 'Требуется вход в систему'} <a href="/">На главную</a></div>;
  if (roles && !roles.includes(user.role)) {
    return <div className="alert">Недостаточно прав для просмотра этой страницы.</div>;
  }
  return children;
}

export default function App() {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [loc.pathname, loc.search]);
  return (
    <>
      <Header onBurger={() => setMenu((m) => !m)} />
      <div className="layout">
        <Sidebar open={menu} />
        <main className="main">
          <Routes>
            <Route path="/" element={<RequireAuth><Search /></RequireAuth>} />
            <Route path="/documents/new" element={<RequireAuth roles={EDITOR_ROLES}><DocumentEdit key="new" /></RequireAuth>} />
            <Route path="/documents/:id" element={<RequireAuth><DocumentView /></RequireAuth>} />
            <Route path="/documents/:id/edit" element={<RequireAuth roles={EDITOR_ROLES}><DocumentEdit /></RequireAuth>} />
            <Route path="/types" element={<RequireAuth roles={EDITOR_ROLES}><DocTypes /></RequireAuth>} />
            <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
            <Route path="*" element={<p className="muted center">Страница не найдена</p>} />
          </Routes>
        </main>
      </div>
    </>
  );
}
