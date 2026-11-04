const { poolFor } = require('../db');

const pool = poolFor('public');
pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

const query = (text, params) => pool.query(text, params);

/** Выполнить функцию в транзакции: fn(client) */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
