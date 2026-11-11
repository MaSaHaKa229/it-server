// Доступ к документам: ограничения по видам и по папкам (задаёт администратор портала).
//   modules.docs_types   — null (все виды) или список кодов видов
//   modules.docs_folders — null (все папки) или список id папок; доступ к папке даёт доступ
//                          ко всем вложенным. Документы «без папки» видят только те, у кого нет ограничения.
const { poolFor } = require('../db');

const db = () => poolFor('docs');

/** Список папок, выданных пользователю (как задано администратором): null — все */
function grantedFolders(u) {
  if (!u || u.role === 'superadmin') return null;
  const f = u.modules && u.modules.docs_folders;
  return Array.isArray(f) ? f.map(Number).filter(Number.isInteger) : null;
}

/** Выданные папки вместе со всеми вложенными: null — без ограничения */
async function allowedFolderIds(u) {
  const granted = grantedFolders(u);
  if (granted === null) return null;
  if (!granted.length) return [];
  const { rows } = await db().query(
    `WITH RECURSIVE t AS (
       SELECT id FROM folders WHERE id = ANY($1::int[])
       UNION SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
     SELECT id FROM t`, [granted]);
  return rows.map((r) => r.id);
}

/** Условия SQL «документ виден пользователю»; p — функция добавления параметра */
function visibleConds(user, p, alias = 'd') {
  const c = [];
  if (user.docTypes) c.push(`${alias}.doc_type = ANY(${p(user.docTypes)}::text[])`);
  if (user.folderIds) c.push(`${alias}.folder_id = ANY(${p(user.folderIds)}::int[])`);
  return c;
}

const canSeeDoc = (user, d) =>
  (!user.docTypes || user.docTypes.includes(d.doc_type)) &&
  (!user.folderIds || (d.folder_id != null && user.folderIds.includes(d.folder_id)));

module.exports = { grantedFolders, allowedFolderIds, visibleConds, canSeeDoc };
