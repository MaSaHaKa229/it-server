import { createContext, useContext, useEffect, useState } from 'react';
import { api, logoutPortal } from './api.js';
import { DOC_TYPES } from './constants.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/auth/me')
      .then((d) => setUser(d.user))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Виды документов, доступные пользователю (ограничение задаёт администратор портала)
  const docTypes = user?.docTypes
    ? Object.fromEntries(Object.entries(DOC_TYPES).filter(([k]) => user.docTypes.includes(k)))
    : DOC_TYPES;

  return (
    <AuthContext.Provider value={{ user, loading, error, docTypes, logout: logoutPortal }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
