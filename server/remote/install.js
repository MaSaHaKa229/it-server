// Удалённая установка программы специалиста (ITRemoteViewer) на компьютер сотрудника ИТ-отдела.
// Портал запускает на сервере PowerShell-сценарий install-viewer.ps1: он по WMI и через общий ресурс C$
// копирует программу и выполняет её установку «для всего компьютера» от имени указанного администратора.
// Пароль администратора передаётся сценарию через stdin, нигде не сохраняется и не попадает в журнал.
const { spawn } = require('child_process');
const path = require('path');
const L = require('./lib');

const SCRIPT = path.join(__dirname, 'install-viewer.ps1');
const DOWNLOADS = path.join(__dirname, '..', '..', 'public', 'remote', 'downloads');
const MAX_PARALLEL = 3;
const TIMEOUT_MS = 10 * 60 * 1000;
let running = 0;

/** PowerShell: на сервере Windows — встроенный powershell.exe; при разработке в Linux — pwsh */
function powershell() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

async function addStep(id, step) {
  await L.query(`UPDATE remote.installs SET steps = steps || $2::jsonb WHERE id = $1`, [id, JSON.stringify([{ ...step, at: new Date().toISOString() }])]);
}

/**
 * Начать установку. Возвращает id записи сразу; ход установки — в remote.installs.steps.
 * o = { specialist: {id, name}, computer, adminUser, password, server, startedBy: {id, name} }
 */
async function startInstall(o) {
  if (running >= MAX_PARALLEL) {
    const e = new Error(`Одновременно идёт ${running} установки — дождитесь их окончания`);
    e.status = 429;
    throw e;
  }
  const { rows } = await L.query(
    `INSERT INTO remote.installs (user_id, user_name, computer, started_by, started_by_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [o.specialist.id, o.specialist.name, o.computer, o.startedBy.id, o.startedBy.name]);
  const id = rows[0].id;
  running++;

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
  if (process.env.REMOTE_INSTALL_DRYRUN === '1') args.push('-DryRun'); // разработка: шаги без настоящего подключения
  let child;
  try {
    child = spawn(powershell(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    running--;
    await finish(id, false, 'Не удалось запустить PowerShell: ' + e.message);
    return id;
  }

  let buf = '';
  let stderr = '';
  let lastError = null;
  let done = null;
  let chain = Promise.resolve();
  const onLine = (line) => {
    line = line.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { return; } // посторонний вывод PowerShell
    if (m.state === 'fail') lastError = m.text;
    if (m.step === 'done' && m.state === 'ok') done = m;
    if (m.step === 'connect' && m.state === 'ok' && m.os) chain = chain.then(() => L.query('UPDATE remote.installs SET os = $2 WHERE id = $1', [id, m.os]));
    chain = chain.then(() => addStep(id, { step: m.step, state: m.state, text: String(m.text || '').slice(0, 2000) }));
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });

  const timer = setTimeout(() => { lastError = 'Установка не завершилась за 10 минут'; child.kill(); }, TIMEOUT_MS);
  const ended = (code, spawnError) => {
    clearTimeout(timer);
    running--;
    if (buf) onLine(buf);
    chain = chain.then(async () => {
      const ok = code === 0 && !!done;
      let err = lastError;
      if (!ok && !err) {
        err = spawnError
          ? (spawnError.code === 'ENOENT' ? 'На сервере не найден PowerShell' : spawnError.message)
          : (stderr.trim().split('\n').slice(-3).join(' ') || `Сценарий установки завершился с кодом ${code}`);
        await addStep(id, { step: 'error', state: 'fail', text: err.slice(0, 2000) });
      }
      await L.query(`UPDATE remote.installs SET status = $2, version = $3, finished_at = now() WHERE id = $1`,
        [id, ok ? 'ok' : 'failed', done ? done.version || null : null]);
      console.log(`Удалённый доступ: установка программы специалиста на ${o.computer} — ${ok ? 'готово' : 'ошибка: ' + err}`);
    }).catch((e) => console.error('Удалённая установка:', e.message));
  };
  child.on('error', (e) => ended(-1, e));
  child.on('close', (code) => ended(code));
  // Параметры — через stdin, чтобы пароль не был виден в списке процессов
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({
    computer: o.computer, user: o.adminUser, password: o.password, server: o.server, downloads: DOWNLOADS,
  }));
  return id;
}

async function finish(id, ok, text) {
  await addStep(id, { step: 'error', state: 'fail', text });
  await L.query(`UPDATE remote.installs SET status = $2, finished_at = now() WHERE id = $1`, [id, ok ? 'ok' : 'failed']);
}

module.exports = { startInstall };
