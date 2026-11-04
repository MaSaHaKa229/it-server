// Общие настройки подключения к PostgreSQL.
// Все модули работают в одной базе (той же, где уже лежит ИТ-инвентарь):
//   public   — ИТ-инвентарь и пользователи портала
//   docs     — реестр документов
//   calendar — календарь задач
//   helpdesk — заявки сотрудников
const { Pool, types } = require('pg');

// DATE возвращаем строкой 'YYYY-MM-DD', чтобы не было сдвигов по часовому поясу
types.setTypeParser(1082, (v) => v);

function baseConfig() {
  return process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'itdb',
      };
}

const pools = {};
/** Пул соединений, у которого search_path начинается со схемы модуля */
function poolFor(schema = 'public') {
  if (!pools[schema]) {
    const cfg = { ...baseConfig(), max: 10 };
    if (schema !== 'public') cfg.options = `-c search_path=${schema},public`;
    const p = new Pool(cfg);
    p.on('error', (err) => console.error(`PostgreSQL (${schema}):`, err.message));
    pools[schema] = p;
  }
  return pools[schema];
}

async function closeAll() {
  await Promise.all(Object.values(pools).map((p) => p.end().catch(() => {})));
}

module.exports = { poolFor, closeAll };
