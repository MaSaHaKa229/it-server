// Почта портала: настройки SMTP задаёт администратор портала (Администрирование → Почта).
// Если в базе настроек нет — используются SMTP_* из .env (как раньше). Без SMTP письма не отправляются.
const { query } = require('../inventory/db');
const { encrypt, decrypt } = require('../inventory/crypto');

let cfg = null;       // действующие настройки {host, port, secure, user, pass, from, reject}
let source = 'none';  // откуда: db | env | none
let transport = null;

function envCfg() {
  if (!process.env.SMTP_HOST) return null;
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 25),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    reject: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === 'true',
  };
}

async function readDb() {
  try {
    const { rows } = await query(`SELECT value FROM portal_settings WHERE key = 'smtp'`);
    return rows[0] ? rows[0].value : null;
  } catch {
    return null; // таблицы ещё нет (до миграции)
  }
}

/** Загрузить настройки (при запуске и после сохранения) */
async function load() {
  const v = await readDb();
  if (v && v.host) {
    let pass = '';
    try { pass = v.pass_enc ? decrypt(v.pass_enc) : ''; } catch { pass = ''; }
    cfg = { host: v.host, port: Number(v.port) || 25, secure: !!v.secure, user: v.user || '', pass, from: v.from || v.user || '', reject: !!v.reject };
    source = 'db';
  } else if (v && v.disabled) {
    cfg = null; source = 'off';
  } else {
    cfg = envCfg(); source = cfg ? 'env' : 'none';
  }
  transport = null;
}

const enabled = () => !!(cfg && cfg.host);

function makeTransport(c) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass || '' } : undefined,
    // Во внутренней сети часто самоподписанные сертификаты
    tls: { rejectUnauthorized: !!c.reject },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
}

function getTransport() {
  if (!enabled()) return null;
  if (!transport) transport = makeTransport(cfg);
  return transport;
}

const fromOf = (c) => c.from || c.user || 'it-portal@localhost';

/** Отправить письмо; ошибки только пишутся в журнал */
async function send(to, subject, text) {
  const t = getTransport();
  if (!t || !to) return false;
  try {
    await t.sendMail({ from: fromOf(cfg), to, subject, text });
    return true;
  } catch (e) {
    console.error('Не удалось отправить письмо:', e.message);
    return false;
  }
}

/** Письмо, которое обязательно должно уйти (ошибка — исключение) */
async function sendStrict(to, subject, text) {
  const t = getTransport();
  if (!t) throw Object.assign(new Error('Почта не настроена'), { status: 500 });
  await t.sendMail({ from: fromOf(cfg), to, subject, text });
}

/** Настройки для страницы администратора (без пароля) */
async function settingsView() {
  const v = (await readDb()) || {};
  const env = envCfg();
  return {
    host: v.host || '', port: v.port || 25, secure: !!v.secure, user: v.user || '', from: v.from || '', reject: !!v.reject,
    has_pass: !!v.pass_enc, disabled: !!v.disabled,
    source, enabled: enabled(),
    env: env ? { host: env.host, port: env.port, user: env.user } : null,
  };
}

/** Сохранить настройки. pass: undefined — не менять, '' — очистить */
async function save(b) {
  const old = (await readDb()) || {};
  const v = {
    host: String(b.host || '').trim().slice(0, 200),
    port: Math.min(65535, Math.max(1, Number(b.port) || 25)),
    secure: !!b.secure,
    user: String(b.user || '').trim().slice(0, 200),
    from: String(b.from || '').trim().slice(0, 200),
    reject: !!b.reject,
    pass_enc: old.pass_enc || null,
    disabled: !!b.disabled,
  };
  if (typeof b.pass === 'string') v.pass_enc = b.pass ? encrypt(b.pass) : null;
  await query(`INSERT INTO portal_settings (key, value) VALUES ('smtp', $1)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  await load();
}

/** Проверочное письмо с текущими настройками */
async function test(to) {
  if (!enabled()) throw Object.assign(new Error('Почта не настроена: укажите SMTP-сервер'), { status: 400 });
  await makeTransport(cfg).sendMail({ from: fromOf(cfg), to, subject: 'Проверка почты ИТ-портала',
    text: 'Это проверочное письмо ИТ-портала. Если вы его получили — уведомления на почту работают.' });
}

module.exports = { load, enabled, send, sendStrict, settingsView, save, test };
