// Сайт заявок для сотрудников предприятия (отдельный порт, по умолчанию 3100).
// Регистрация по внутренней почте, создание заявок и просмотр своих заявок.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { HttpError, ah, str, intOrNull } = require('../inventory/util');
const L = require('./lib');
const notify = require('./notify');
const calendarSync = require('./calendar-sync');

const { query, tx } = L;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- защита от перебора ----------
const attempts = new Map();
function limited(key, max = 10) {
  const a = attempts.get(key);
  if (a && Date.now() - a.first > 15 * 60 * 1000) attempts.delete(key);
  const cur = attempts.get(key);
  if (cur && cur.count >= max) throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут');
}
function failed(key) {
  const a = attempts.get(key);
  if (!a) attempts.set(key, { first: Date.now(), count: 1 }); else a.count++;
}

const newCode = () => String(crypto.randomInt(100000, 1000000));

async function sendCode(r, purpose) {
  const code = newCode();
  await query(`UPDATE requesters SET verify_code = $2, verify_expires = now() + interval '30 minutes' WHERE id = $1`,
    [r.id, await bcrypt.hash(code, 8)]);
  const what = purpose === 'reset' ? 'восстановления пароля' : 'подтверждения регистрации';
  await L.sendMailStrict(r.email, `Код ${what} — заявки в службу ИТ`,
    `Здравствуйте, ${r.full_name}!\n\nКод для ${what}: ${code}\nКод действует 30 минут.\n\n` +
    `Если вы не запрашивали код, просто проигнорируйте это письмо.\n${L.helpdeskUrl()}`);
}

async function checkCode(r, code) {
  if (!r.verify_code || !r.verify_expires || new Date(r.verify_expires) < new Date()) {
    throw new HttpError(400, 'Код устарел. Запросите новый');
  }
  if (!(await bcrypt.compare(String(code || '').trim(), r.verify_code))) throw new HttpError(400, 'Неверный код');
}

function domainAllowed(email, domains) {
  if (!domains.length) return true;
  const d = email.split('@')[1].toLowerCase();
  return domains.includes(d);
}

const getRequester = async (email) =>
  (await query('SELECT * FROM requesters WHERE lower(email) = lower($1)', [email])).rows[0];

const PROFILE = 'id, email, full_name, department, department_id, position, phone, room, created_at';

function createHelpdeskApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet({
    hsts: process.env.COOKIE_SECURE === 'true',
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'upgrade-insecure-requests': process.env.COOKIE_SECURE === 'true' ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    name: 'helpdesk.sid',
    store: new PgStore({ pool: L.pool, schemaName: 'helpdesk', tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 30 * 24 * 3600 * 1000,
    },
  }));

  // CSRF: изменяющие запросы только из нашего фронтенда
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'helpdesk') return res.status(403).json({ error: 'Запрос отклонён' });
    next();
  });

  // Текущий сотрудник
  app.use('/api', ah(async (req, res, next) => {
    if (req.session.requesterId) {
      const { rows } = await query('SELECT * FROM requesters WHERE id = $1', [req.session.requesterId]);
      const r = rows[0];
      if (r && r.is_active && r.is_approved && r.email_verified) req.requester = r;
      else req.session.destroy(() => {});
    }
    next();
  }));
  const auth = (req, res, next) => (req.requester ? next() : res.status(401).json({ error: 'Войдите в систему' }));
  const me = (req) => ({ requesterId: req.requester.id });

  const api = express.Router();

  api.get('/config', ah(async (req, res) => {
    const s = await L.getSettings();
    res.json({
      domains: s.allowed_domains, requireApproval: s.require_approval, welcome: s.welcome_text,
      mailEnabled: L.mailEnabled(), portalUrl: L.portalUrl(), priorities: L.PRIORITIES,
      brand: require('../portal/branding').publicView(await require('../portal/branding').get()),
    });
  }));

  // Справочник отделов — для выбора при регистрации и в профиле (вход не нужен)
  api.get('/departments', ah(async (req, res) => {
    res.json({ departments: await L.departments() });
  }));

  // ---------- регистрация и вход ----------
  api.post('/register', ah(async (req, res) => {
    limited('reg:' + req.ip, 20);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const fullName = str(b.full_name, 200);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Укажите рабочий e-mail');
    if (!fullName) throw new HttpError(400, 'Укажите ФИО');
    if (!b.password || String(b.password).length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
    const s = await L.getSettings();
    if (!domainAllowed(email, s.allowed_domains)) {
      throw new HttpError(400, `Регистрация возможна только с внутренней почтой: ${s.allowed_domains.map((d) => '@' + d).join(', ')}`);
    }
    failed('reg:' + req.ip);
    const existing = await getRequester(email);
    if (existing && existing.email_verified) throw new HttpError(409, 'Этот e-mail уже зарегистрирован. Войдите или восстановите пароль');
    const mail = L.mailEnabled();
    const dep = await L.resolveDepartment(b);
    const vals = [email, fullName, dep.name, str(b.position, 200), str(b.phone, 50), str(b.room, 100),
      await bcrypt.hash(String(b.password), 10), !s.require_approval, !mail, dep.id];
    let r;
    if (existing) {
      // Повторная регистрация неподтверждённого адреса — обновляем данные
      r = (await query(
        `UPDATE requesters SET email = $1, full_name = $2, department = $3, position = $4, phone = $5, room = $6,
                password_hash = $7, is_approved = $8, email_verified = $9, department_id = $10 WHERE id = $11 RETURNING *`,
        [...vals, existing.id])).rows[0];
    } else {
      r = (await query(
        `INSERT INTO requesters (email, full_name, department, position, phone, room, password_hash, is_approved, email_verified, department_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, vals)).rows[0];
    }
    if (mail) {
      await sendCode(r, 'verify');
      return res.status(201).json({ next: 'verify', email });
    }
    if (s.require_approval) {
      notify.newRequester(r).catch(() => {});
      return res.status(201).json({ next: 'approval' });
    }
    await new Promise((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
    req.session.requesterId = r.id;
    res.status(201).json({ next: 'done' });
  }));

  api.post('/verify', ah(async (req, res) => {
    const email = String(req.body.email || '').trim();
    limited('code:' + email.toLowerCase());
    const r = await getRequester(email);
    if (!r) throw new HttpError(400, 'Неверный код');
    try { await checkCode(r, req.body.code); } catch (e) { failed('code:' + email.toLowerCase()); throw e; }
    await query('UPDATE requesters SET email_verified = TRUE, verify_code = NULL, verify_expires = NULL WHERE id = $1', [r.id]);
    if (!r.is_approved) {
      notify.newRequester(r).catch(() => {});
      return res.json({ next: 'approval' });
    }
    await new Promise((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
    req.session.requesterId = r.id;
    res.json({ next: 'done' });
  }));

  api.post('/resend', ah(async (req, res) => {
    const email = String(req.body.email || '').trim();
    limited('resend:' + email.toLowerCase(), 5);
    failed('resend:' + email.toLowerCase());
    const r = await getRequester(email);
    if (r && !r.email_verified && L.mailEnabled()) await sendCode(r, 'verify');
    res.json({ ok: true });
  }));

  api.post('/login', ah(async (req, res) => {
    const key = 'login:' + req.ip;
    limited(key);
    const email = String(req.body.email || '').trim();
    const r = await getRequester(email);
    if (!r || !(await bcrypt.compare(String(req.body.password || ''), r.password_hash))) {
      failed(key);
      throw new HttpError(401, 'Неверный e-mail или пароль');
    }
    if (!r.email_verified) {
      if (L.mailEnabled()) {
        await sendCode(r, 'verify');
        return res.status(403).json({ error: 'Подтвердите e-mail: мы отправили новый код', next: 'verify', email: r.email });
      }
      await query('UPDATE requesters SET email_verified = TRUE WHERE id = $1', [r.id]);
    }
    if (!r.is_approved) throw new HttpError(403, 'Регистрация ещё не подтверждена службой ИТ');
    if (!r.is_active) throw new HttpError(403, 'Учётная запись заблокирована. Обратитесь в службу ИТ');
    attempts.delete(key);
    await new Promise((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
    req.session.requesterId = r.id;
    await query('UPDATE requesters SET last_login = now() WHERE id = $1', [r.id]);
    res.json({ ok: true });
  }));

  api.post('/logout', (req, res) => {
    req.session.destroy(() => { res.clearCookie('helpdesk.sid'); res.json({ ok: true }); });
  });

  api.post('/forgot', ah(async (req, res) => {
    if (!L.mailEnabled()) throw new HttpError(400, 'Для смены пароля обратитесь в службу ИТ');
    const email = String(req.body.email || '').trim();
    limited('forgot:' + email.toLowerCase(), 5);
    failed('forgot:' + email.toLowerCase());
    const r = await getRequester(email);
    if (r && r.is_active) await sendCode(r, 'reset');
    res.json({ ok: true }); // не раскрываем, есть ли такой адрес
  }));

  api.post('/reset', ah(async (req, res) => {
    const email = String(req.body.email || '').trim();
    limited('code:' + email.toLowerCase());
    if (!req.body.password || String(req.body.password).length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
    const r = await getRequester(email);
    if (!r) throw new HttpError(400, 'Неверный код');
    try { await checkCode(r, req.body.code); } catch (e) { failed('code:' + email.toLowerCase()); throw e; }
    await query(`UPDATE requesters SET password_hash = $2, email_verified = TRUE, verify_code = NULL, verify_expires = NULL
                  WHERE id = $1`, [r.id, await bcrypt.hash(String(req.body.password), 10)]);
    res.json({ ok: true });
  }));

  // ---------- профиль ----------
  api.get('/me', auth, (req, res) => {
    const r = req.requester;
    res.json({ id: r.id, email: r.email, full_name: r.full_name, department: r.department, department_id: r.department_id, position: r.position, phone: r.phone, room: r.room });
  });

  api.patch('/me', auth, ah(async (req, res) => {
    const b = req.body || {};
    const fullName = str(b.full_name, 200);
    if (!fullName) throw new HttpError(400, 'Укажите ФИО');
    const dep = await L.resolveDepartment(b);
    const { rows } = await query(
      `UPDATE requesters SET full_name = $2, department = $3, position = $4, phone = $5, room = $6, department_id = $7
        WHERE id = $1 RETURNING ${PROFILE}`,
      [req.requester.id, fullName, dep.name, str(b.position, 200), str(b.phone, 50), str(b.room, 100), dep.id]);
    res.json(rows[0]);
  }));

  api.post('/me/password', auth, ah(async (req, res) => {
    const { current, next } = req.body || {};
    if (!next || String(next).length < 8) throw new HttpError(400, 'Новый пароль должен быть не короче 8 символов');
    if (!(await bcrypt.compare(String(current || ''), req.requester.password_hash))) {
      throw new HttpError(400, 'Текущий пароль указан неверно');
    }
    await query('UPDATE requesters SET password_hash = $2 WHERE id = $1', [req.requester.id, await bcrypt.hash(String(next), 10)]);
    res.json({ ok: true });
  }));

  // ---------- заявки ----------
  api.get('/categories', auth, ah(async (req, res) => {
    const { rows } = await query('SELECT id, name, description, icon FROM categories WHERE is_active ORDER BY sort, name');
    res.json(rows);
  }));

  api.get('/statuses', auth, ah(async (req, res) => {
    const { rows } = await query('SELECT id, name, color, is_closed FROM statuses ORDER BY sort, id');
    res.json(rows);
  }));

  api.get('/tickets', auth, ah(async (req, res) => {
    const where = ['t.requester_id = $1'];
    if (req.query.state === 'open') where.push('NOT s.is_closed');
    if (req.query.state === 'closed') where.push('s.is_closed');
    const { rows } = await query(
      `${L.TICKET_SELECT}
        WHERE ${where.join(' AND ')}
        ORDER BY s.is_closed, t.updated_at DESC LIMIT 500`, [req.requester.id]);
    res.json(rows.map(publicTicket));
  }));

  api.post('/tickets', auth, L.upload.array('files', 5), ah(async (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 200);
    const description = str(b.description, 20000) || '';
    if (!title) throw new HttpError(400, 'Кратко опишите проблему в поле «Тема»');
    const categoryId = intOrNull(b.category_id);
    const priority = L.PRIORITIES[b.priority] ? b.priority : 'normal';
    const id = await tx(async (db) => {
      const cat = categoryId ? (await db.query('SELECT * FROM categories WHERE id = $1 AND is_active', [categoryId])).rows[0] : null;
      if (categoryId && !cat) throw new HttpError(400, 'Вид проблемы не найден');
      const st = (await db.query('SELECT id FROM statuses ORDER BY is_default DESC, sort, id LIMIT 1')).rows[0];
      // Исполнитель — по правилам автоназначения (вид проблемы, отдел), иначе исполнитель вида проблемы
      const auto = await require('./autoassign').pick(db, { category: cat, departmentId: req.requester.department_id || null });
      const { rows } = await db.query(
        // Срок выполнения заявитель не задаёт — его выставляет администратор helpdesk
        `INSERT INTO tickets (requester_id, category_id, status_id, priority, title, description, location, assignee_id, due_at, due_auto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [req.requester.id, cat ? cat.id : null, st.id, priority, title, description,
          str(b.location, 200) || req.requester.room, auto ? auto.assigneeId : null, L.slaDue(cat), !!L.slaDue(cat)]);
      await L.addHistory(db, rows[0].id, me(req), 'created');
      if (auto) await L.addHistory(db, rows[0].id, {}, 'assignee', { from: null, to: auto.name, auto: true, how: auto.how });
      if (L.slaDue(cat)) await L.addHistory(db, rows[0].id, {}, 'due', { from: null, to: L.slaDue(cat), auto: true });
      await L.saveAttachments(db, rows[0].id, null, req.files, me(req));
      return rows[0].id;
    });
    await calendarSync.syncTicket(id);
    notify.ticketCreated(id).catch(() => {});
    res.status(201).json({ id });
  }));

  async function ownTicket(req) {
    const id = intOrNull(req.params.id);
    const { rows } = await query(`${L.TICKET_SELECT} WHERE t.id = $1 AND t.requester_id = $2`, [id, req.requester.id]);
    if (!rows[0]) throw new HttpError(404, 'Заявка не найдена');
    return rows[0];
  }

  api.get('/tickets/:id', auth, ah(async (req, res) => {
    const t = await ownTicket(req);
    const [comments, files, history] = await Promise.all([
      query(`SELECT c.id, c.body, c.created_at, c.requester_id IS NOT NULL AS mine,
                    COALESCE(r.full_name, CASE WHEN u.is_service THEN 'Служба ИТ' ELSE COALESCE(NULLIF(u.full_name, ''), u.username) END, 'Служба ИТ') AS author
               FROM comments c
               LEFT JOIN requesters r ON r.id = c.requester_id
               LEFT JOIN public.users u ON u.id = c.user_id
              WHERE c.ticket_id = $1 AND NOT c.is_internal ORDER BY c.created_at, c.id`, [t.id]),
      query(`SELECT id, comment_id, filename, mime_type, size, created_at FROM attachments
              WHERE ticket_id = $1 AND NOT is_internal ORDER BY id`, [t.id]),
      query(`SELECT h.action, h.details, h.created_at FROM history h
              WHERE h.ticket_id = $1 AND h.action IN ('created','status','assignee','due','priority','category')
              ORDER BY h.created_at, h.id`, [t.id]),
    ]);
    res.json({ ...publicTicket(t), comments: comments.rows, attachments: files.rows, history: history.rows });
  }));

  api.post('/tickets/:id/comments', auth, L.upload.array('files', 5), ah(async (req, res) => {
    const t = await ownTicket(req);
    const body = str(req.body.body, 20000);
    if (!body && !(req.files || []).length) throw new HttpError(400, 'Напишите комментарий или приложите файл');
    await tx(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO comments (ticket_id, requester_id, body) VALUES ($1, $2, $3) RETURNING id',
        [t.id, req.requester.id, body || '(файл)']);
      await L.saveAttachments(db, t.id, rows[0].id, req.files, me(req));
      await db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
    });
    notify.requesterCommented(t.id, body).catch(() => {});
    res.status(201).json({ ok: true });
  }));

  api.get('/attachments/:id', auth, ah(async (req, res) => {
    const { rows } = await query(
      `SELECT a.filename, a.mime_type, a.data FROM attachments a JOIN tickets t ON t.id = a.ticket_id
        WHERE a.id = $1 AND t.requester_id = $2 AND NOT a.is_internal`, [intOrNull(req.params.id), req.requester.id]);
    if (!rows[0]) throw new HttpError(404, 'Файл не найден');
    L.sendAttachment(res, rows[0]);
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

  const pub = path.join(__dirname, '..', '..', 'public', 'helpdesk');
  // Скрипты и стили перепроверяются при каждом открытии (см. cacheHeaders в server/index.js)
  const noCache = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
  app.use('/shared', express.static(path.join(__dirname, '..', '..', 'public', 'shared'), noCache));
  app.use(express.static(pub, { index: 'index.html', ...noCache }));
  app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Файл слишком большой (максимум ${L.MAX_FILE / 1024 / 1024} МБ)`
        : err.code === 'LIMIT_FILE_COUNT' ? 'Можно приложить не больше 5 файлов' : err.message;
      return res.status(400).json({ error: msg });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
  });
  return app;
}

// Заявитель видит всё, кроме служебных полей
function publicTicket(t) {
  return {
    id: t.id, title: t.title, description: t.description, location: t.location, priority: t.priority,
    due_at: t.due_at, created_at: t.created_at, updated_at: t.updated_at, closed_at: t.closed_at,
    category_name: t.category_name, category_icon: t.category_icon,
    status_name: t.status_name, status_color: t.status_color, is_closed: t.is_closed,
    assignee_name: t.assignee_name, is_overdue: t.is_overdue,
  };
}

module.exports = { createHelpdeskApp };
