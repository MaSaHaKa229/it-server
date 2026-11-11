import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, logoutPortal } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [portal, setPortal] = useState(null); // права на разделы портала — для меню
  const [types, setTypes] = useState([]);
  const [folders, setFolders] = useState({ items: [], unfiled: null, restricted: false });
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Справочник видов документов (видимые пользователю) с количеством документов
  // Вместе с видами обновляем папки и теги — счётчики в боковой панели
  const reloadTypes = useCallback(() => Promise.all([
    api('/doc-types').then((d) => setTypes(d.items)),
    api('/folders').then(setFolders),
    api('/tags').then((d) => setTags(d.items)),
  ]).catch(() => {}), []);

  useEffect(() => {
    api('/auth/me')
      .then(async (d) => {
        setUser(d.user);
        await reloadTypes();
        fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then(setPortal).catch(() => {});
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [reloadTypes]);

  const value = useMemo(() => {
    const typeMap = Object.fromEntries(types.map((t) => [t.code, t]));
    return {
      user, portal, loading, error, types, typeMap, reloadTypes, logout: logoutPortal,
      folders: folders.items, unfiled: folders.unfiled, restrictedFolders: folders.restricted, tags,
      folderMap: Object.fromEntries(folders.items.map((f) => [f.id, f])),
      // { code: name } — для выпадающих списков
      docTypes: Object.fromEntries(types.map((t) => [t.code, t.name])),
      typeName: (code) => typeMap[code]?.name || code,
    };
  }, [user, portal, loading, error, types, folders, tags, reloadTypes]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
