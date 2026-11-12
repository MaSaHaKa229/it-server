// Состояние системы: фоновые задания (когда работали, были ли ошибки), последние ошибки журнала,
// самопроверка после запуска. Показывается в Администрирование → «Состояние системы».

const START = new Date();
const jobs = new Map();       // имя → { label, every, lastRun, lastOk, lastError, lastErrorAt, runs, fails, info }
const errors = [];            // последние ошибки из журнала (console.error)
const MAX_ERRORS = 100;

/** Перехватить console.error: сообщения по-прежнему пишутся в журнал и запоминаются для страницы состояния */
function captureErrors() {
  if (console.error.__health) return;
  const orig = console.error.bind(console);
  const wrapped = (...args) => {
    try {
      const text = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      errors.push({ at: new Date().toISOString(), text: text.slice(0, 2000) });
      if (errors.length > MAX_ERRORS) errors.shift();
    } catch { /* не мешаем журналу */ }
    orig(...args);
  };
  wrapped.__health = true;
  console.error = wrapped;
}

/** Описать фоновое задание: every — как часто должно работать (минут), для отметки «давно не работало» */
function register(name, label, every) {
  if (!jobs.has(name)) jobs.set(name, { label, every, lastRun: null, lastOk: null, lastError: null, lastErrorAt: null, runs: 0, fails: 0, info: null });
}

/** Выполнить задание с учётом: fn — async; info — что вернуло задание (кратко) */
async function track(name, fn) {
  const j = jobs.get(name);
  const t0 = Date.now();
  try {
    const r = await fn();
    if (j) { j.lastRun = new Date(); j.lastOk = j.lastRun; j.runs++; j.ms = Date.now() - t0; if (r !== undefined) j.info = r; }
    return r;
  } catch (e) {
    if (j) { j.lastRun = new Date(); j.lastError = e.message; j.lastErrorAt = j.lastRun; j.runs++; j.fails++; j.ms = Date.now() - t0; }
    throw e;
  }
}

function list() {
  const now = Date.now();
  return [...jobs.entries()].map(([name, j]) => {
    const late = j.every && (j.lastRun ? now - j.lastRun.getTime() > j.every * 60000 * 2 + 5 * 60000
      : now - START.getTime() > j.every * 60000 + 5 * 60000);
    const failing = j.lastErrorAt && (!j.lastOk || j.lastErrorAt > j.lastOk);
    return { name, ...j, state: failing ? 'error' : late ? 'late' : j.lastRun ? 'ok' : 'waiting' };
  });
}

module.exports = { captureErrors, register, track, list, errors, START };
