import { Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { EDITOR_ROLES } from './constants.js';
import Header from './components/Header.jsx';
import Search from './pages/Search.jsx';
import DocumentView from './pages/DocumentView.jsx';
import DocumentEdit from './pages/DocumentEdit.jsx';
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
  return (
    <>
      <Header />
      <main className="container">
        <Routes>
          <Route path="/" element={<RequireAuth><Search /></RequireAuth>} />
          <Route
            path="/documents/new"
            element={<RequireAuth roles={EDITOR_ROLES}><DocumentEdit key="new" /></RequireAuth>}
          />
          <Route path="/documents/:id" element={<RequireAuth><DocumentView /></RequireAuth>} />
          <Route
            path="/documents/:id/edit"
            element={<RequireAuth roles={EDITOR_ROLES}><DocumentEdit /></RequireAuth>}
          />
          <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="*" element={<p className="muted center">Страница не найдена</p>} />
        </Routes>
      </main>
    </>
  );
}
