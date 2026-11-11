import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { applyColors, setColorModes } from './constants.js';

const loadModes = () => { try { return { tasks: 'category', absences: 'kind', ...JSON.parse(localStorage.getItem('cal.colorModes') || '{}') }; } catch { return { tasks: 'category', absences: 'kind' }; } };

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ user, setUser, children }) {
  const [users, setUsers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [toasts, setToasts] = useState([]);
  // Цвета: заданные администратором (общие) и личная раскраска; при изменении — перерисовка
  const [colors, setColorsState] = useState({});
  const [colorModes, setModesState] = useState(() => { const m = loadModes(); setColorModes(m); return m; });
  const setColors = useCallback((c) => { applyColors(c); setColorsState(c); }, []);
  const setModes = useCallback((m) => {
    setColorModes(m); setModesState({ ...m });
    try { localStorage.setItem('cal.colorModes', JSON.stringify(m)); } catch { /* нет места */ }
  }, []);

  const toast = useCallback((text, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const reloadUsers = useCallback(() => api.get('/users').then((d) => setUsers(d.users)), []);
  const reloadCategories = useCallback(() => api.get('/categories').then((d) => setCategories(d.categories)), []);

  useEffect(() => {
    reloadUsers(); reloadCategories();
    api.get('/settings/colors').then((d) => setColors(d.colors)).catch(() => {});
  }, [reloadUsers, reloadCategories, setColors]);

  const value = useMemo(() => ({
    user, setUser, users, categories, reloadUsers, reloadCategories, toast, colors, setColors, colorModes, setModes,
    canEdit: user.role === 'admin' || user.role === 'editor',
    isAdmin: user.role === 'admin',
  }), [user, setUser, users, categories, reloadUsers, reloadCategories, toast, colors, setColors, colorModes, setModes]);

  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </AppCtx.Provider>
  );
}
