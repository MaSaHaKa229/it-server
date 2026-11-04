import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ user, setUser, children }) {
  const [users, setUsers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((text, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const reloadUsers = useCallback(() => api.get('/users').then((d) => setUsers(d.users)), []);
  const reloadCategories = useCallback(() => api.get('/categories').then((d) => setCategories(d.categories)), []);

  useEffect(() => { reloadUsers(); reloadCategories(); }, [reloadUsers, reloadCategories]);

  const value = useMemo(() => ({
    user, setUser, users, categories, reloadUsers, reloadCategories, toast,
    canEdit: user.role === 'admin' || user.role === 'editor',
    isAdmin: user.role === 'admin',
  }), [user, setUser, users, categories, reloadUsers, reloadCategories, toast]);

  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </AppCtx.Provider>
  );
}
