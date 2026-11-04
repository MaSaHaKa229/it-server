import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { poolFor } = require('../db.js');

// Таблицы календаря лежат в схеме calendar
export const pool = poolFor('calendar');

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function logActivity(db, userId, action, entity, entityId, details = {}) {
  await db.query(
    'INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, entity, entityId, details]
  );
}
