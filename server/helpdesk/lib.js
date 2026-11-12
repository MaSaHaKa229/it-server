// Общие функции helpdesk: БД, настройки, почта, вложения, история
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { poolFor } = require('../db');

const pool = poolFor('helpdesk');
const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Домены почты из .env — начальное значение настройки
  const envDomains = parseDomains(process.env.HELPDESK_EMAIL_DOMAINS);
  if (envDomains.length) {
    await query(`UPDATE settings SET value = $1 WHERE key = 'allowed_domains' AND value = '[]'::jsonb`,
      [JSON.stringify(envDomains)]);
  }
}

const parseDomains = (v) => String(v || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

// ---------- настройки ----------
async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    allowed_domains: Array.isArray(s.allowed_domains) ? s.allowed_domains : [],
    require_approval: !!s.require_approval,
    welcome_text: typeof s.welcome_text === 'string' ? s.welcome_text : '',
  };
}
async function setSetting(key, value) {
  await query(`INSERT INTO settings (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}

// ---------- почта (необязательно: если SMTP не настроен, письма не отправляются) ----------
// Настройки почты — общие для портала (server/portal/mail.js): из Администрирования или из .env
const mail = require('../portal/mail');
const mailEnabled = () => mail.enabled();
/** Отправить письмо; ошибки только пишутся в журнал, чтобы не ломать работу с заявкой */
const sendMail = (to, subject, text) => mail.send(to, subject, text);
/** Письмо, которое обязательно должно уйти (код подтверждения) */
const sendMailStrict = (to, subject, text) => mail.sendStrict(to, subject, text);

const helpdeskUrl = () => (process.env.HELPDESK_URL || `http://localhost:${process.env.HELPDESK_PORT || 3100}`).replace(/\/$/, '');
const portalUrl = () => (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ---------- вложения ----------
const MAX_FILE = 10 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|ps1|vbs|js|jar|reg|lnk|hta|cpl)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 5, fields: 30 },
  fileFilter: (req, file, cb) => {
    // multer отдаёт имя в latin1 — восстанавливаем UTF-8
    try {
      const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
      if (!decoded.includes('�')) file.originalname = decoded;
    } catch { /* оставляем как есть */ }
    if (BLOCKED_EXT.test(file.originalname)) {
      return cb(Object.assign(new Error('Исполняемые файлы прикладывать нельзя'), { status: 400 }));
    }
    cb(null, true);
  },
});

async function saveAttachments(db, ticketId, commentId, files, who, isInternal = false) {
  for (const f of files || []) {
    await db.query(
      `INSERT INTO attachments (ticket_id, comment_id, filename, mime_type, size, data, requester_id, user_id, is_internal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ticketId, commentId, f.originalname.slice(0, 250), f.mimetype || 'application/octet-stream', f.size, f.buffer,
        who.requesterId || null, who.userId || null, !!isInternal]);
  }
}

function sendAttachment(res, a) {
  const inline = /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.mime_type) || a.mime_type === 'application/pdf';
  res.set('Content-Type', a.mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.send(a.data);
}

async function addHistory(db, ticketId, who, action, details = {}) {
  await db.query(
    'INSERT INTO history (ticket_id, user_id, requester_id, action, details) VALUES ($1, $2, $3, $4, $5)',
    [ticketId, who.userId || null, who.requesterId || null, action, JSON.stringify(details)]);
}

/** Срок по нормативу вида проблемы (от момента from) или null */
const slaDue = (cat, from = new Date()) => (cat && cat.sla_hours ? new Date(new Date(from).getTime() + cat.sla_hours * 3600e3) : null);

const PRIORITIES = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', critical: 'Критический' };

// Общий SELECT заявки
const TICKET_SELECT = `
  SELECT t.id, t.title, t.description, t.location, t.priority, t.due_at, t.due_auto, t.channel, t.created_at, t.updated_at, t.closed_at,
         t.requester_id, t.category_id, t.status_id, t.assignee_id, t.device_id, t.calendar_task_id,
         c.name AS category_name, c.icon AS category_icon,
         s.name AS status_name, s.color AS status_color, s.is_closed,
         r.full_name AS requester_name, r.email AS requester_email, r.department AS requester_department,
         r.phone AS requester_phone, r.room AS requester_room,
         CASE WHEN u.is_service THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END AS assignee_name,
         (t.due_at IS NOT NULL AND t.due_at < now() AND NOT s.is_closed) AS is_overdue
    FROM tickets t
    JOIN statuses s ON s.id = t.status_id
    JOIN requesters r ON r.id = t.requester_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN public.users u ON u.id = t.assignee_id`;

/**
 * Отдел заявителя: { id, name }. По department_id из справочника «Отделы» инвентаря;
 * иначе — по тексту: если он совпадает со значением, полным или коротким названием отдела, берём его из справочника,
 * если нет — сохраняем как написано (id = null).
 */
async function resolveDepartment(b) {
  const id = Number(b.department_id) || null;
  if (id) {
    const { rows } = await query(`SELECT id, value FROM public.lookups WHERE id = $1 AND kind = 'department'`, [id]);
    if (rows[0]) return { id: rows[0].id, name: rows[0].value };
  }
  const text = b.department == null ? '' : String(b.department).trim().slice(0, 200);
  if (!text) return { id: null, name: null };
  const { rows } = await query(
    `SELECT id, value FROM public.lookups WHERE kind = 'department'
       AND (lower(value) = lower($1) OR lower(full_name) = lower($1) OR lower(short_name) = lower($1))
     ORDER BY (lower(value) = lower($1)) DESC LIMIT 1`, [text]);
  return rows[0] ? { id: rows[0].id, name: rows[0].value } : { id: null, name: text };
}

/** Справочник «Отделы» для выбора при регистрации */
async function departments() {
  const { rows } = await query(
    `SELECT id, value AS name, full_name, short_name FROM public.lookups WHERE kind = 'department' ORDER BY lower(value) LIMIT 3000`);
  return rows;
}

module.exports = {
  resolveDepartment, departments,
  pool, query, tx, migrate, parseDomains, getSettings, setSetting,
  mailEnabled, sendMail, sendMailStrict, helpdeskUrl, portalUrl,
  upload, saveAttachments, sendAttachment, addHistory, PRIORITIES, TICKET_SELECT, MAX_FILE, slaDue,
};
