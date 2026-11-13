// ИТ-портал: главная страница, ИТ-инвентарь, документы, задачи с календарём, заявки (helpdesk).
//   PORT          (3000) — портал для сотрудников ИТ-отдела
//   HELPDESK_PORT (3100) — сайт заявок для всех сотрудников предприятия
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { poolFor } = require('./db');
const { initAll } = require('./setup');
const { loadUser, requireAuth, requireStaff } = require('./inventory/access');
const { atLeast, requireModule } = require('./portal/modules');

const PORT = Number(process.env.PORT || 3000);
const HELPDESK_PORT = Number(process.env.HELPDESK_PORT || 3100);
const isProd = process.env.NODE_ENV === 'production';
const PUB = path.join(__dirname, '..', 'public');

if (!process.env.SESSION_SECRET || !process.env.APP_SECRET_KEY) {
  console.error('Заполните SESSION_SECRET и APP_SECRET_KEY в файле .env (см. .env.example)');
  process.exit(1);
}

async function main() {
  console.log('Подготовка базы данных…');
  await initAll();
  const calendar = await import('./calendar/index.js');

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
        // Не принуждаем к HTTPS: сайт часто работает во внутренней сети по HTTP
        'upgrade-insecure-requests': process.env.COOKIE_SECURE === 'true' ? [] : null,
      },
    },
  }));

  // Общая сессия для всех разделов портала (cookie та же, что была у ИТ-инвентаря)
  app.use(session({
    name: 'itdb.sid',
    store: new PgStore({ pool: poolFor('public'), tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));

  // Защита от CSRF: изменяющие запросы к API должны прийти из нашего фронтенда
  const API = /^\/(api|inventory\/api|docs\/api|calendar\/api|helpdesk\/api|remote\/api)(\/|$)/;
  app.use((req, res, next) => {
    if (!API.test(req.path) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.get('X-Requested-With')) return res.status(403).json({ error: 'Запрос отклонён' });
    next();
  });

  app.use(loadUser);

  // ---------- API портала ----------
  const portalApi = express.Router();
  portalApi.use(express.json({ limit: '1mb' }));
  portalApi.use('/auth', require('./portal/auth').router);
  portalApi.use('/admin', require('./portal/admin'));
  portalApi.use('/summary', require('./portal/summary'));
  app.use('/api', portalApi);

  // ---------- ИТ-инвентарь ----------
  const inv = express.Router();
  const jsonSmall = express.json({ limit: '1mb' });
  const jsonBig = express.json({ limit: '40mb' }); // импорт из Excel передаёт файл целиком
  inv.use((req, res, next) => (req.url.startsWith('/import/') ? jsonBig : jsonSmall)(req, res, next));
  inv.use(requireModule('inventory'));
  inv.get('/auth/me', (req, res) => {
    const { id, username, full_name, email, role } = req.user;
    res.json({ user: { id, username, full_name, email, role }, perms: req.perms });
  });
  inv.use('/users', require('./inventory/routes/users'));
  inv.use('/devices', requireAuth, require('./inventory/routes/devices'));
  inv.use('/export', requireAuth, require('./inventory/routes/export'));
  inv.use('/import', requireStaff, require('./inventory/routes/import'));
  inv.use('/workplaces', requireAuth, require('./inventory/routes/workplaces'));
  inv.use('/', requireAuth, require('./inventory/routes/catalog'));
  app.use('/inventory/api', inv);

  // ---------- Документы, календарь, helpdesk ----------
  app.use('/docs/api', require('./docs').apiRouter());
  app.use('/calendar/api', calendar.apiRouter());
  app.use('/helpdesk/api', require('./helpdesk/staff'));

  // ---------- Удалённый доступ ----------
  const remote = require('./remote');
  app.use('/remote/api', remote.apiRouter());
  app.use('/remote/agent-api', remote.agentRouter());  // агенты на компьютерах пользователей (без сессии)

  const API_ONLY = /^\/(api|inventory\/api|docs\/api|calendar\/api|helpdesk\/api|remote\/api|remote\/agent-api)(\/|$)/;
  app.use((req, res, next) => (API_ONLY.test(req.path) ? res.status(404).json({ error: 'Не найдено' }) : next()));

  // ---------- Страницы ----------
  const staticOpts = { index: false, setHeaders: cacheHeaders };
  const sendPage = (file) => (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(file, (err) => {
      if (!err || res.headersSent) return;
      // Файл страницы не найден — почти всегда это неполная папка public после обновления
      const rel = path.relative(path.join(__dirname, '..'), file);
      console.error(`Не найден файл ${rel}. Проверьте папку public (см. сообщение при запуске).`);
      res.status(500).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Ошибка установки</title>' +
        '<div style="font:15px/1.5 sans-serif;max-width:640px;margin:60px auto;color:#172B4D">' +
        '<h2>Портал установлен не полностью</h2>' +
        `<p>Не найден файл <code>${rel}</code>.</p>` +
        '<p>В папке портала в <code>public</code> должны быть папки: ' + PUBLIC_DIRS.join(', ') + '. ' +
        'Скопируйте недостающие из полного архива обновления и перезапустите портал.</p></div>');
    });
  };
  /** Страница доступна только вошедшим пользователям с доступом к модулю */
  const guard = (mod, min) => (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (mod && !atLeast(req.user, mod, min)) return res.redirect('/?denied=' + mod);
    next();
  };

  app.get('/login', (req, res, next) => (req.user ? res.redirect(safeNext(req.query.next)) : next()),
    sendPage(path.join(PUB, 'portal', 'login.html')));
  app.get('/', guard(), sendPage(path.join(PUB, 'portal', 'index.html')));
  app.get('/admin', guard(), (req, res, next) => (req.user.role === 'superadmin' ? next() : res.redirect('/?denied=admin')),
    sendPage(path.join(PUB, 'portal', 'admin.html')));
  app.use('/portal', express.static(path.join(PUB, 'portal'), staticOpts));
  app.use('/shared', express.static(path.join(PUB, 'shared'), staticOpts));

  const mountSpa = (prefix, dir, mod, min) => {
    app.get(prefix, (req, res, next) => (req.originalUrl.split('?')[0] === prefix ? res.redirect(prefix + '/') : next()));
    app.use(prefix, express.static(path.join(PUB, dir), staticOpts));
    app.get(prefix + '/*', guard(mod, min), sendPage(path.join(PUB, dir, 'index.html')));
  };
  mountSpa('/inventory', 'inventory', 'inventory', 'view');
  mountSpa('/docs', 'docs', 'docs', 'view');
  mountSpa('/calendar', 'calendar', 'calendar', 'view');
  mountSpa('/helpdesk', 'helpdesk-staff', 'helpdesk', 'executor');
  // Загрузки (просмотрщик, агент) — файлы большие и неизменные внутри версии, отдаются как есть
  app.use('/remote/downloads', guard('remote', 'view'), express.static(path.join(PUB, 'remote', 'downloads'), { index: false }));
  mountSpa('/remote', 'remote', 'remote', 'view');

  app.use((req, res) => res.redirect('/'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && isProd ? 'Внутренняя ошибка сервера' : err.message });
  });

  app.listen(PORT, () => console.log(`ИТ-портал запущен: http://localhost:${PORT}`));
  checkPublic();

  if (HELPDESK_PORT) {
    const { createHelpdeskApp } = require('./helpdesk/public');
    createHelpdeskApp().listen(HELPDESK_PORT, () =>
      console.log(`Сайт заявок (helpdesk) запущен: http://localhost:${HELPDESK_PORT}`));
  }
}

/**
 * Кэширование статики.
 * Скрипты и стили портала подключаются по постоянным адресам (/shared/ui.js и т.п.), поэтому браузер
 * должен перепроверять их при каждом открытии (no-cache + ETag: если файл не менялся — ответ 304).
 * Иначе после обновления сервера браузер смешивает старые и новые модули и страница не открывается.
 * Долго кэшируются только собранные файлы «Документов» и «Календаря» — у них хэш в имени.
 */
function cacheHeaders(res, filePath) {
  if (/[\\/]assets[\\/][^\\/]+-[\w-]{8,}\.(js|css)$/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

// Папки интерфейса, без которых портал не работает
const PUBLIC_DIRS = ['portal', 'shared', 'inventory', 'docs', 'calendar', 'helpdesk-staff', 'helpdesk', 'remote'];

/** Проверка при запуске: все ли папки интерфейса на месте (частая ошибка при ручном обновлении) */
function checkPublic() {
  const fs = require('fs');
  // В shared нет страниц — только общие стили и скрипты
  const marker = (d) => (d === 'shared' ? 'ui.js' : 'index.html');
  const missing = PUBLIC_DIRS.filter((d) => !fs.existsSync(path.join(PUB, d, marker(d))));
  if (!missing.length) return;
  console.error('\n  ВНИМАНИЕ: папка public неполная. Нет: ' + missing.map((d) => `public\\${d}`).join(', '));
  console.error(`  Папка: ${PUB}`);
  console.error('  Скопируйте недостающие папки из полного архива обновления и перезапустите портал.\n');
}

/** Переход после входа — только на страницы этого же сайта */
function safeNext(next) {
  const n = String(next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

main().catch((e) => {
  console.error('Не удалось запустить портал:', e.message);
  process.exit(1);
});
