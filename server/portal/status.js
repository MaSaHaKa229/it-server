// Администрирование → «Состояние системы»: версия, сервер, база, место на диске, фоновые задания,
// последние ошибки и самопроверка (всё ли на месте после обновления). Только администратор портала.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { query } = require('../inventory/db');
const { ah } = require('../inventory/util');
const H = require('./health');
const mail = require('./mail');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const PUBLIC_DIRS = ['portal', 'shared', 'inventory', 'docs', 'calendar', 'helpdesk-staff', 'helpdesk', 'remote'];

function version() {
  let v = {};
  try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'version.json'), 'utf8')); } catch { /* сборка разработчика */ }
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* нет */ }
  return { version: pkg.version || '', built: v.built || null, commit: v.commit || null };
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Самопроверка: [{ ok: true|false|'warn', title, text }] */
async function selfCheck(backupState) {
  const out = [];
  const add = (ok, title, text) => out.push({ ok, title, text });
  // Папка public
  const marker = (d) => (d === 'shared' ? 'ui.js' : 'index.html');
  const missing = PUBLIC_DIRS.filter((d) => !fs.existsSync(path.join(PUB, d, marker(d))));
  add(!missing.length, 'Файлы сайта (папка public)', missing.length ? `Не хватает: ${missing.map((d) => 'public\\' + d).join(', ')} — скопируйте из полного архива обновления`
    : 'Все разделы на месте');
  // Секреты
  add(!!process.env.APP_SECRET_KEY, 'Ключ шифрования APP_SECRET_KEY', process.env.APP_SECRET_KEY ? 'Задан' : 'Не задан в .env — пароли устройств и почты не сохранятся');
  const ss = process.env.SESSION_SECRET || '';
  const weak = /change|secret|example|пример/i.test(ss);
  add(ss && !weak && ss.length >= 16 ? true : 'warn', 'Ключ сессий SESSION_SECRET',
    !ss ? 'Не задан в .env' : weak ? 'Похоже на значение из примера — замените в .env на свою длинную случайную строку'
      : ss.length < 16 ? 'Короткий — лучше длиннее 16 символов' : 'Задан');
  // Распознавание сканов
  try {
    const ocr = require('../docs/ocr');
    add(ocr.available() ? true : 'warn', 'Распознавание сканов PDF', ocr.available() ? 'Компоненты найдены'
      : 'Компоненты не найдены — проверьте папку server\\vendor\\ocr из архива обновления');
  } catch (e) { add('warn', 'Распознавание сканов PDF', e.message); }
  // Почта
  add(mail.enabled() ? true : 'warn', 'Почта', mail.enabled() ? 'Настроена (проверочное письмо — во вкладке «Уведомления и почта»)' : 'Не настроена — письма не отправляются');
  // Резервные копии
  const last = backupState && backupState.last_ok_at ? new Date(backupState.last_ok_at) : null;
  const age = last ? (Date.now() - last.getTime()) / 864e5 : null;
  add(last && age < 2 ? true : last ? 'warn' : false, 'Резервные копии',
    last ? `Последняя: ${last.toLocaleString('ru-RU')}${age >= 2 ? ' — больше двух дней назад' : ''}` : 'Копий ещё не было — создайте во вкладке «Резервные копии»');
  // Проверка копии: можно ли из неё восстановиться
  try {
    const vs = await require('./backup').verifyState();
    const v = vs.last;
    const vage = v ? (Date.now() - new Date(v.at).getTime()) / 864e5 : null;
    add(v ? (v.ok ? (vage < 9 ? true : 'warn') : false) : 'warn', 'Проверка резервной копии',
      !v ? 'Копии ещё не проверялись — проверка идёт раз в неделю после ночной копии или кнопкой «Проверить» во вкладке «Резервные копии»'
        : v.ok ? `${new Date(v.at).toLocaleString('ru-RU')}: копия ${v.name} читается целиком, из неё можно восстановиться (таблиц ${v.tables}, записей ${v.rows})${vage >= 9 ? ' — но это было давно' : ''}`
          : `${new Date(v.at).toLocaleString('ru-RU')}: копия ${v.name} НЕ прошла проверку — ${v.error}`);
  } catch (e) { add('warn', 'Проверка резервной копии', e.message); }
  // База
  try {
    const { rows } = await query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('public','docs','calendar','helpdesk')`);
    add(rows[0].n > 40, 'База данных', `Таблиц: ${rows[0].n} — обновление базы при запуске прошло`);
  } catch (e) { add(false, 'База данных', e.message); }
  // Место на диске
  const d = disk(ROOT);
  if (d) add(d.free / d.total > 0.1 && d.free > 2e9 ? true : 'warn', 'Место на диске', `Свободно ${(d.free / 1e9).toFixed(1)} ГБ из ${(d.total / 1e9).toFixed(1)} ГБ`);
  return out;
}

router.get('/', ah(async (req, res) => {
  const [db, tables, conn, backup] = await Promise.all([
    query(`SELECT pg_database_size(current_database()) AS size, version() AS version, current_database() AS name`),
    query(`SELECT n.nspname || '.' || c.relname AS name, pg_total_relation_size(c.oid) AS size
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname IN ('public','docs','calendar','helpdesk')
            ORDER BY 2 DESC LIMIT 8`),
    query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
    query(`SELECT value FROM portal_settings WHERE key = 'backup_state'`).catch(() => ({ rows: [] })),
  ]);
  const backupState = backup.rows[0] ? backup.rows[0].value : null;
  const mem = process.memoryUsage();
  res.json({
    version: version(),
    server: {
      hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, node: process.version,
      started: H.START, uptime: process.uptime(), memory: mem.rss, totalmem: os.totalmem(), freemem: os.freemem(),
      folder: ROOT, disk: disk(ROOT),
    },
    db: { name: db.rows[0].name, size: Number(db.rows[0].size), version: db.rows[0].version.split(',')[0], connections: conn.rows[0].n,
      tables: tables.rows.map((t) => ({ name: t.name, size: Number(t.size) })) },
    jobs: H.list(),
    backup: backupState,
    errors: H.errors.slice(-50).reverse(),
    checks: await selfCheck(backupState),
  });
}));

module.exports = router;
