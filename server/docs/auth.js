// Авторизация через портал: пользователь берётся из общей сессии,
// роль в реестре документов вычисляется из его прав на модуль «Документы».
const { level } = require('../portal/modules');
const { syncUser, docsRole } = require('../portal/sync');
const { allowedFolderIds } = require('./access');

async function requireAuth(req, res, next) {
  const u = req.portalUser || req.user;
  if (!u) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (level(u, 'docs') === 'none') return res.status(403).json({ error: 'Нет доступа к разделу «Документы»' });
  let folderIds;
  try {
    await syncUser(u);
    folderIds = await allowedFolderIds(u);
  } catch (e) {
    return next(e);
  }
  req.portalUser = u;
  const m = u.modules || {};
  req.user = {
    id: u.id,
    username: u.username,
    full_name: u.full_name || '',
    role: docsRole(u),
    is_active: true,
    // Виды документов, доступные пользователю (null — все)
    docTypes: u.role === 'superadmin' || !Array.isArray(m.docs_types) || !m.docs_types.length ? null : m.docs_types,
    // Доступные папки вместе с вложенными (null — все; документы без папки видны только при null)
    folderIds,
  };
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role)
    ? next()
    : res.status(403).json({ error: 'Недостаточно прав' });

module.exports = { requireAuth, requireRole };
