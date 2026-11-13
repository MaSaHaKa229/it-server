// Подготовка базы данных для всех модулей портала. Идемпотентно — выполняется при каждом запуске.
const fs = require('fs');
const path = require('path');
const { poolFor } = require('./db');

async function initAll({ demo = false, quiet = false } = {}) {
  const log = (m) => { if (!quiet) console.log(m); };

  // 1. ИТ-инвентарь (схема public) + первый суперадмин
  const inventory = require('./inventory/init');
  await inventory.init({ demo, quiet: true });
  log('  ✓ ИТ-инвентарь');

  // 2. Дополнения портала: права на модули, схемы модулей, pg_trgm
  const sql = fs.readFileSync(path.join(__dirname, 'portal', 'schema.sql'), 'utf8');
  const [main, ext] = sql.split('-- pg_trgm');
  await poolFor('public').query(main);
  try {
    await poolFor('public').query('-- pg_trgm' + ext);
  } catch (e) {
    const has = await poolFor('public').query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    if (!has.rows[0]) {
      throw new Error(
        `Не удалось установить расширение pg_trgm (${e.message}).\n` +
        '  Выполните один раз от имени администратора PostgreSQL (postgres) в базе портала:\n' +
        '    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;');
    }
  }
  log('  ✓ Портал');

  // 3. Модули
  await require('./docs').migrate();
  log('  ✓ Документы');
  const calendar = await import('./calendar/index.js');
  await calendar.migrate();
  log('  ✓ Задачи и календарь');
  await require('./helpdesk/lib').migrate();
  log('  ✓ Helpdesk');
  await require('./remote').migrate();
  log('  ✓ Удалённый доступ');

  // 4. Пользователи портала → модули
  await require('./portal/sync').syncAll();

  // 5. Заявки с исполнителем, которых ещё нет в календаре
  const n = await require('./helpdesk/calendar-sync').backfill();
  if (n) log(`  ✓ В календарь добавлено заявок: ${n}`);
}

module.exports = { initAll };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  console.log('Подготовка базы данных…');
  initAll({ demo: process.argv.includes('--demo') })
    .then(() => console.log('База данных готова'))
    .catch((e) => { console.error('Ошибка:', e.message); process.exitCode = 1; })
    .finally(() => require('./db').closeAll());
}
