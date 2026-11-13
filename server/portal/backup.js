// Резервное копирование базы портала (Администрирование → Резервные копии).
//
// Копия — один файл *.itbak (gzip, внутри строки JSON): все таблицы схем public, docs, calendar, helpdesk
// (включая файлы документов и вложения заявок — они хранятся в базе). Делается средствами самого портала,
// без pg_dump, поэтому работает от того же пользователя базы, что и портал.
// Восстановление — в одной транзакции: при ошибке база остаётся как была. Перед восстановлением
// автоматически делается копия текущего состояния.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
const express = require('express');
const multer = require('multer');
const { poolFor } = require('../db');
const { HttpError, ah } = require('../inventory/util');
const audit = require('./audit');

const SCHEMAS = ['public', 'docs', 'calendar', 'helpdesk'];
const SKIP = new Set(['public.session', 'helpdesk.session']); // сессии входа не сохраняем
const FORMAT = 'it-portal-backup';
// Папка по умолчанию; сценарий обновления запускает копию из распакованного архива и указывает папку установленного портала
const DEFAULT_DIR = process.env.PORTAL_BACKUP_DEFAULT_DIR || path.join(__dirname, '..', '..', 'backups');
const NAME_RE = /^itportal-[\w.-]+\.itbak$/;

const pool = () => poolFor('public');
const q = (sql, vals) => pool().query(sql, vals);

// ---------------- настройки и состояние ----------------
const DEF = { enabled: true, time: '02:30', keep: 14, dir: '' };

async function getSetting(key, def) {
  const { rows } = await q('SELECT value FROM portal_settings WHERE key = $1', [key]);
  return { ...def, ...((rows[0] && rows[0].value) || {}) };
}
async function setSetting(key, value) {
  await q(`INSERT INTO portal_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]);
}
const settings = () => getSetting('backup', DEF);
const state = () => getSetting('backup_state', {});
const dirOf = (s) => (s.dir && s.dir.trim() ? path.resolve(s.dir.trim()) : DEFAULT_DIR);

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------- список таблиц ----------------
async function tables(client) {
  const { rows } = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name,
            array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attgenerated = '') AS cols
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[])
      GROUP BY n.nspname, c.relname ORDER BY n.nspname, c.relname`, [SCHEMAS]);
  return rows.filter((r) => !SKIP.has(`${r.schema}.${r.name}`));
}
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const fq = (t) => `${qi(t.schema)}.${qi(t.name)}`;

// ---------------- создание копии ----------------
let busy = null; // одна операция за раз

function lock(name, fn) {
  if (busy) throw new HttpError(409, `Уже выполняется: ${busy}. Подождите.`);
  busy = name;
  return Promise.resolve().then(fn).finally(() => { busy = null; });
}

/** Создать копию; kind — auto | manual | before-restore. Возвращает {file, size, tables, rows} */
async function createBackup(kind = 'manual', who = null) {
  const s = await settings();
  const dir = dirOf(s);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `itportal-${stamp()}-${kind}.itbak`);
  const tmp = file + '.part';
  const client = await pool().connect();
  let total = 0;
  let count = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const list = await tables(client);
    const gz = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(tmp);
    gz.pipe(out);
    const done = new Promise((ok, ko) => { out.on('finish', ok); out.on('error', ko); gz.on('error', ko); });
    const write = (obj) => new Promise((ok) => { if (gz.write(JSON.stringify(obj) + '\n')) ok(); else gz.once('drain', ok); });
    await write({ format: FORMAT, version: 1, created_at: new Date().toISOString(), kind, host: os.hostname(), tables: list.map((t) => `${t.schema}.${t.name}`) });
    for (const t of list) {
      await write({ table: `${t.schema}.${t.name}`, columns: t.cols });
      await client.query(`DECLARE bk NO SCROLL CURSOR FOR SELECT to_jsonb(x)::text AS j FROM ${fq(t)} x`);
      for (;;) {
        const { rows } = await client.query('FETCH 500 FROM bk');
        if (!rows.length) break;
        for (const r of rows) {
          if (!gz.write(r.j + '\n')) await new Promise((ok) => gz.once('drain', ok));
        }
        total += rows.length;
      }
      await client.query('CLOSE bk');
      await write({ end: `${t.schema}.${t.name}` });
      count++;
    }
    await write({ finished: true, rows: total });
    gz.end();
    await done;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    client.release();
  }
  fs.renameSync(tmp, file);
  const size = fs.statSync(file).size;
  await setSetting('backup_state', { ...(await state()), last_ok_at: new Date().toISOString(), last_file: path.basename(file), last_size: size, last_kind: kind, last_error: null });
  await audit.log(who || { username: 'автоматически' }, 'backup_created', path.basename(file), { size, tables: count, rows: total, kind });
  return { file: path.basename(file), size, tables: count, rows: total };
}

/** Удалить лишние автоматические копии (оставить keep самых новых) */
function cleanup(s) {
  const dir = dirOf(s);
  const keep = Math.max(1, Number(s.keep) || 14);
  const auto = listFiles(dir).filter((f) => f.kind === 'auto');
  for (const f of auto.slice(keep)) fs.rmSync(path.join(dir, f.name), { force: true });
}

function listFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => NAME_RE.test(n)).map((n) => {
    const st = fs.statSync(path.join(dir, n));
    const kind = (n.match(/-(auto|manual|before-restore|before-update|uploaded)\.itbak$/) || [])[1] || 'manual';
    return { name: n, size: st.size, mtime: st.mtime, kind };
  }).sort((a, b) => b.mtime - a.mtime);
}

// ---------------- чтение копии ----------------
/** Перебрать строки копии: onHeader(h), onTable(t), onRow(t, obj), onEnd(t) */
async function readBackup(file, handlers) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let table = null;
  let finished = false;
  for await (const line of rl) {
    if (!line) continue;
    const obj = JSON.parse(line);
    if (!header) {
      if (obj.format !== FORMAT) throw new HttpError(400, 'Это не файл резервной копии ИТ-портала');
      header = obj;
      if (handlers.onHeader) await handlers.onHeader(obj);
      continue;
    }
    if (!table) {
      if (obj.finished) { finished = true; break; }
      if (!obj.table) throw new HttpError(400, 'Файл копии повреждён');
      table = obj;
      if (handlers.onTable) await handlers.onTable(obj);
      continue;
    }
    if (obj && obj.end === table.table && Object.keys(obj).length === 1) {
      if (handlers.onEnd) await handlers.onEnd(table);
      table = null;
      continue;
    }
    if (handlers.onRow) await handlers.onRow(table, obj, line.length);
  }
  if (!header) throw new HttpError(400, 'Файл копии пустой или повреждён');
  if (!finished) throw new HttpError(400, 'Файл копии не полный (обрезан) — восстановление невозможно');
  return header;
}

/** Краткие сведения о копии (без загрузки в базу) */
async function inspect(file) {
  const counts = {};
  const header = await readBackup(file, { onTable: (t) => { counts[t.table] = 0; }, onRow: (t) => { counts[t.table]++; } });
  return { created_at: header.created_at, kind: header.kind, host: header.host, tables: Object.keys(counts).length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0), counts };
}

// ---------------- проверка копии ----------------
// Копия читается целиком и каждая строка загружается во временную таблицу с устройством текущей таблицы
// (типы, обязательные поля). Настоящие таблицы не меняются, транзакция в конце откатывается.
// Так видно, что из копии действительно можно восстановиться — а не только что файл существует.
const verifyState = () => getSetting('backup_verify', { files: {} });

async function verify(file) {
  const t0 = Date.now();
  const client = await pool().connect();
  let total = 0;
  let tablesOk = 0;
  const skipped = [];
  let header = null;
  try {
    await client.query('BEGIN');
    const list = await tables(client);
    const byName = new Map(list.map((t) => [`${t.schema}.${t.name}`, t]));
    let cur = null;
    let cols = null;
    let tmp = null;
    let batch = [];
    let bytes = 0;
    let n = 0;
    const flush = async () => {
      if (!batch.length) return;
      const c = cols.map(qi).join(', ');
      try {
        await client.query(`INSERT INTO ${tmp} (${c}) SELECT ${c} FROM jsonb_populate_recordset(NULL::${fq(cur)}, $1::jsonb)`, [JSON.stringify(batch)]);
      } catch (e) {
        throw new Error(`таблица ${cur.schema}.${cur.name}: ${e.message}`);
      }
      total += batch.length;
      batch = []; bytes = 0;
    };
    header = await readBackup(file, {
      onTable: async (t) => {
        cur = byName.get(t.table) || null;
        if (!cur) { skipped.push(t.table); return; }
        cols = cur.cols.filter((c) => t.columns.includes(c));
        tmp = `pg_temp.vt_${++n}`;
        await client.query(`CREATE TEMP TABLE vt_${n} (LIKE ${fq(cur)} INCLUDING DEFAULTS)`);
      },
      onRow: async (t, row, size) => {
        if (!cur) return;
        batch.push(row); bytes += size;
        if (batch.length >= 500 || bytes > 16 * 1024 * 1024) await flush();
      },
      onEnd: async () => {
        if (cur) { await flush(); await client.query(`DROP TABLE ${tmp}`); tablesOk++; }
        cur = null;
      },
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  return { ok: true, created_at: header && header.created_at, tables: tablesOk, rows: total, skipped, seconds: Math.round((Date.now() - t0) / 1000) };
}

/** Проверить копию и запомнить итог (для списка копий и «Состояния системы») */
async function verifyAndSave(name, who) {
  const f = path.join(dirOf(await settings()), name);
  let r;
  try {
    r = await verify(f);
  } catch (e) {
    const m = String(e.message || e);
    r = { ok: false, error: /unexpected end of file/i.test(m) ? 'файл копии обрезан (неполный) — например, не дописался или скопировался не до конца'
      : /incorrect header check|invalid (block|stored|distance)/i.test(m) ? 'файл повреждён или это не резервная копия портала'
        : /Unexpected token|JSON/i.test(m) ? `файл копии повреждён (${m.slice(0, 120)})` : m };
  }
  r.at = new Date().toISOString();
  const vs = await verifyState();
  const files = {};
  const existing = new Set(listFiles(dirOf(await settings())).map((x) => x.name));
  for (const [k, v] of Object.entries(vs.files || {})) if (existing.has(k)) files[k] = v;
  files[name] = r;
  await setSetting('backup_verify', { files, last: { name, ...r } });
  await audit.log(who || { username: 'автоматически' }, r.ok ? 'backup_verified' : 'backup_verify_failed', name,
    r.ok ? { tables: r.tables, rows: r.rows } : { error: r.error });
  if (!r.ok) {
    const N = require('./notify');
    await N.emit(await N.usersWhere((u) => u.role === 'superadmin'), 'system',
      { title: 'Резервная копия не прошла проверку', body: `${name}: ${r.error}`, link: '/admin#backup' }).catch(() => {});
  }
  return r;
}

// ---------------- восстановление ----------------
async function restore(file, who) {
  // Сначала проверим файл целиком, чтобы не начинать с повреждённым
  await inspect(file);
  const before = await createBackup('before-restore', who);
  const client = await pool().connect();
  let total = 0;
  try {
    await client.query('BEGIN');
    const list = await tables(client);
    const byName = new Map(list.map((t) => [`${t.schema}.${t.name}`, t]));
    // Внешние ключи — отложенные (порядок таблиц и ссылки внутри таблицы не важны), свои триггеры — выключены
    const { rows: fks } = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name, con.conname, con.condeferrable, con.condeferred
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND n.nspname = ANY($1::text[])`, [SCHEMAS]);
    for (const f of fks) await client.query(`ALTER TABLE ${fq(f)} ALTER CONSTRAINT ${qi(f.conname)} DEFERRABLE INITIALLY DEFERRED`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const t of list) await client.query(`ALTER TABLE ${fq(t)} DISABLE TRIGGER USER`);

    const seen = [];
    let batch = [];
    let batchBytes = 0;
    let cur = null;
    let cols = null;
    const flush = async () => {
      if (!batch.length) return;
      const c = cols.map(qi).join(', ');
      await client.query(`INSERT INTO ${fq(cur)} (${c}) SELECT ${c} FROM jsonb_populate_recordset(NULL::${fq(cur)}, $1::jsonb)`,
        [JSON.stringify(batch)]);
      total += batch.length;
      batch = [];
      batchBytes = 0;
    };
    await readBackup(file, {
      onTable: (t) => { seen.push(t.table); },
    });
    // Очищаем только таблицы, которые есть в копии (новые таблицы, которых в старой копии не было, — тоже очищаются,
    // чтобы не остались ссылки на удалённые строки)
    if (list.length) await client.query(`TRUNCATE ${list.map(fq).join(', ')} CASCADE`);
    await readBackup(file, {
      onTable: async (t) => {
        cur = byName.get(t.table) || null;
        cols = cur ? cur.cols.filter((c) => t.columns.includes(c)) : null;
      },
      onRow: async (t, row, size) => {
        if (!cur) return;
        batch.push(row);
        batchBytes += size;
        // Пачками: до 500 строк или ~16 МБ (файлы документов бывают большими)
        if (batch.length >= 500 || batchBytes > 16 * 1024 * 1024) await flush();
      },
      onEnd: async () => { if (cur) await flush(); cur = null; },
    });
    // Проверка ссылок, затем всё как было
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const f of fks) {
      await client.query(`ALTER TABLE ${fq(f)} ALTER CONSTRAINT ${qi(f.conname)} ${f.condeferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE'}`
        + (f.condeferrable ? (f.condeferred ? ' INITIALLY DEFERRED' : ' INITIALLY IMMEDIATE') : ''));
    }
    for (const t of list) await client.query(`ALTER TABLE ${fq(t)} ENABLE TRIGGER USER`);
    // Счётчики id — после самых больших восстановленных значений
    const { rows: seqs } = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name, a.attname AS col, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL`, [SCHEMAS]);
    for (const s of seqs) {
      await client.query(`SELECT setval($1, COALESCE((SELECT max(${qi(s.col)}) FROM ${fq(s)}), 0) + 1, false)`, [s.seq]);
    }
    await client.query('COMMIT');
    await audit.log(who, 'backup_restored', path.basename(file), { rows: total, tables: seen.length, safety_copy: before.file });
    return { rows: total, tables: seen.length, safety_copy: before.file };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await audit.log(who, 'backup_failed', path.basename(file), { error: e.message, restore: true });
    throw new HttpError(e.status || 500, `Восстановление не выполнено, база осталась без изменений: ${e.message}`);
  } finally {
    client.release();
  }
}

// ---------------- расписание ----------------
async function tick() {
  if (busy) return;
  const s = await settings();
  if (!s.enabled) return;
  const now = new Date();
  const [hh, mm] = String(s.time || '02:30').split(':').map(Number);
  const due = new Date(now); due.setHours(hh || 0, mm || 0, 0, 0);
  if (now < due) return;
  const st = await state();
  const today = now.toDateString();
  if (st.last_auto_day === today) return;
  await setSetting('backup_state', { ...st, last_auto_day: today });
  try {
    const made = await require('./health').track('backup', async () => {
      const r = await lock('резервное копирование по расписанию', () => createBackup('auto'));
      cleanup(s);
      return `${r.file}, ${Math.round(r.size / 1024)} КБ`;
    });
    // Раз в неделю — проверка свежей копии (её можно восстановить)
    const vs = await verifyState();
    if (!vs.last || Date.now() - new Date(vs.last.at).getTime() > 6.5 * 864e5) {
      const name = String(made).split(',')[0];
      await require('./health').track('backup_verify', async () => {
        const r = await lock('проверка резервной копии', () => verifyAndSave(name));
        if (!r.ok) throw new Error(r.error);
        return `${name}: таблиц ${r.tables}, записей ${r.rows}`;
      }).catch((e) => console.error('Проверка резервной копии:', e.message));
    }
  } catch (e) {
    console.error('Резервное копирование:', e.message);
    await setSetting('backup_state', { ...(await state()), last_error: e.message, last_error_at: new Date().toISOString() });
    await audit.log({ username: 'автоматически' }, 'backup_failed', null, { error: e.message });
    const N = require('./notify');
    await N.emit(await N.usersWhere((u) => u.role === 'superadmin'), 'system',
      { title: 'Резервная копия не создана', body: e.message, link: '/admin#backup' });
  }
}

function start() {
  require('./health').register('backup', 'Резервная копия по расписанию', 24 * 60);
  require('./health').register('backup_verify', 'Проверка резервной копии (раз в неделю)', 8 * 24 * 60);
  const run = () => tick().catch((e) => console.error('Резервное копирование:', e.message));
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, 60 * 1000).unref?.();
}

// ---------------- API (только администратор портала) ----------------
const router = express.Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 } });

router.get('/', ah(async (req, res) => {
  const s = await settings();
  const dir = dirOf(s);
  res.json({ settings: s, dir, default_dir: DEFAULT_DIR, state: await state(), files: listFiles(dir), busy, verify: await verifyState() });
}));

router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const time = /^\d{1,2}:\d{2}$/.test(String(b.time || '')) ? String(b.time).padStart(5, '0') : DEF.time;
  const v = { enabled: !!b.enabled, time, keep: Math.min(365, Math.max(1, Number(b.keep) || 14)), dir: String(b.dir || '').trim().slice(0, 400) };
  if (v.dir && !path.isAbsolute(v.dir)) throw new HttpError(400, 'Укажите полный путь к папке, например D:\\Backup\\it-portal');
  const dir = dirOf(v);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new HttpError(400, `Папка ${dir} недоступна для записи: ${e.message}`);
  }
  await setSetting('backup', v);
  await audit.log(req, 'backup_settings', null, v);
  res.json({ ok: true });
}));

router.post('/run', ah(async (req, res) => {
  const r = await lock('создание резервной копии', () => createBackup('manual', req));
  res.json(r);
}));

const fileIn = async (name) => {
  if (!NAME_RE.test(String(name))) throw new HttpError(400, 'Неверное имя файла');
  const f = path.join(dirOf(await settings()), name);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Файл не найден');
  return f;
};

router.get('/files/:name', ah(async (req, res) => {
  const f = await fileIn(req.params.name);
  res.download(f, req.params.name);
}));

router.get('/files/:name/info', ah(async (req, res) => {
  res.json(await inspect(await fileIn(req.params.name)));
}));

router.post('/files/:name/verify', ah(async (req, res) => {
  await fileIn(req.params.name);
  res.json(await lock('проверка резервной копии', () => verifyAndSave(req.params.name, req)));
}));

router.delete('/files/:name', ah(async (req, res) => {
  const f = await fileIn(req.params.name);
  fs.rmSync(f, { force: true });
  await audit.log(req, 'backup_deleted', req.params.name);
  res.json({ ok: true });
}));

router.post('/files/:name/restore', ah(async (req, res) => {
  if ((req.body || {}).confirm !== 'ВОССТАНОВИТЬ') throw new HttpError(400, 'Подтвердите восстановление словом ВОССТАНОВИТЬ');
  const f = await fileIn(req.params.name);
  res.json(await lock('восстановление из резервной копии', () => restore(f, req)));
}));

// Загрузить файл копии с компьютера (например, с другого сервера) — он кладётся в папку копий
router.post('/upload', upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Выберите файл копии (*.itbak)');
  try {
    const info = await inspect(req.file.path).catch((e) => {
      throw new HttpError(400, `Файл повреждён или это не резервная копия портала (${e.message})`);
    });
    const dir = dirOf(await settings());
    fs.mkdirSync(dir, { recursive: true });
    const name = `itportal-${stamp()}-uploaded.itbak`;
    fs.copyFileSync(req.file.path, path.join(dir, name));
    res.json({ name, ...info });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
}));

module.exports = { router, start, createBackup, restore, inspect, verify, verifyState };
