// Синхронизация пользователей портала в таблицы users модулей «Документы» и «Календарь».
// Источник истины — public.users; в модулях хранятся копии с теми же id,
// чтобы работали связи «автор документа», «исполнитель задачи» и т.п.
const { poolFor } = require('../db');
const { level } = require('./modules');

const db = () => poolFor('public');
const cache = new Map(); // userId -> подпись последней синхронизации

const docsRole = (u) => (u.role === 'superadmin' ? 'superadmin' : level(u, 'docs') === 'edit' ? 'editor' : 'reader');
const calRole = (u) => ({ admin: 'admin', edit: 'editor' }[level(u, 'calendar')] || 'viewer');
const displayName = (u) => (u.full_name && u.full_name.trim()) || u.username;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function syncDocs(u) {
  const active = !!u.is_active && level(u, 'docs') !== 'none';
  await db().query(
    `INSERT INTO docs.users (id, username, password_hash, full_name, role, is_active, is_system)
     VALUES ($1, $2, '!', $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, full_name = EXCLUDED.full_name,
       role = EXCLUDED.role, is_active = EXCLUDED.is_active, is_system = EXCLUDED.is_system, updated_at = now()`,
    [u.id, String(u.username).slice(0, 50), displayName(u).slice(0, 200), docsRole(u), active, u.role === 'superadmin']);
}

async function syncCalendar(u) {
  // Активен — учётная запись портала включена (можно назначать исполнителем задач);
  // доступ к разделу — отдельно
  const active = !!u.is_active;
  const access = level(u, 'calendar') !== 'none';
  const fallback = `${String(u.username).toLowerCase()}.${u.id}@portal.local`;
  const email = u.email && EMAIL_RE.test(u.email) ? u.email.trim().toLowerCase() : fallback;
  const upsert = (mail) => db().query(
    `INSERT INTO calendar.users (id, email, name, password_hash, role, is_active, has_access, is_system)
     VALUES ($1, $2, $3, '!', $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
       role = EXCLUDED.role, is_active = EXCLUDED.is_active, has_access = EXCLUDED.has_access, is_system = EXCLUDED.is_system`,
    [u.id, mail, displayName(u), calRole(u), active, access, u.role === 'superadmin']);
  try {
    await upsert(email);
  } catch (e) {
    if (e.code !== '23505' || email === fallback) throw e;
    await upsert(fallback); // такой e-mail уже занят другим пользователем
  }
}

const signature = (u) => JSON.stringify([u.username, u.full_name, u.email, u.role, u.is_active, u.modules]);

/** Синхронизировать одного пользователя (если что-то изменилось) */
async function syncUser(u) {
  const sig = signature(u);
  if (cache.get(u.id) === sig) return;
  await syncDocs(u);
  await syncCalendar(u);
  cache.set(u.id, sig);
}

/** Синхронизировать всех пользователей портала */
async function syncAll() {
  const { rows } = await db().query(
    'SELECT id, username, full_name, email, role, is_active, modules FROM users ORDER BY id');
  for (const u of rows) await syncUser(u);
  // Пользователи, удалённые с портала, отключаются в модулях
  const ids = rows.map((u) => u.id);
  await db().query('UPDATE docs.users SET is_active = FALSE WHERE NOT (id = ANY($1::int[]))', [ids]);
  await db().query('UPDATE calendar.users SET is_active = FALSE WHERE NOT (id = ANY($1::int[]))', [ids]);
}

/** Удаление пользователя с портала */
async function removeUser(id) {
  cache.delete(id);
  await db().query('DELETE FROM docs.users WHERE id = $1', [id]).catch(() =>
    db().query('UPDATE docs.users SET is_active = FALSE WHERE id = $1', [id]));
  await db().query('DELETE FROM calendar.users WHERE id = $1', [id]).catch(() =>
    db().query('UPDATE calendar.users SET is_active = FALSE WHERE id = $1', [id]));
}

module.exports = { syncUser, syncAll, removeUser, docsRole, calRole };
