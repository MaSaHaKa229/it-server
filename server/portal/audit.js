// Журнал входов и действий администраторов (public.audit_log). Смотрит администратор портала.
const { query } = require('../inventory/db');

/** Подписи действий для страницы журнала */
const ACTIONS = {
  login: 'Вход',
  login_failed: 'Неудачная попытка входа',
  logout: 'Выход',
  password_changed: 'Смена своего пароля',
  user_created: 'Создан пользователь',
  user_updated: 'Изменён пользователь',
  user_deleted: 'Удалён пользователь',
  mail_settings: 'Настройки почты',
  notify_settings: 'Пороги уведомлений',
  backup_settings: 'Настройки резервного копирования',
  backup_created: 'Резервная копия создана',
  backup_failed: 'Ошибка резервного копирования',
  backup_restored: 'Восстановление из резервной копии',
  backup_deleted: 'Резервная копия удалена',
  backup_verified: 'Резервная копия проверена',
  backup_verify_failed: 'Резервная копия не прошла проверку',
  netprobe_settings: 'Настройки «Сведений из сети»',
  netscan_schedule: 'Расписание сканирования сети',
  inventory_features: 'Возможности инвентаря (учёт лицензий)',
  branding: 'Оформление (название, логотип)',
  hd_settings: 'Настройки helpdesk',
  hd_category: 'Вид проблемы helpdesk',
  hd_status: 'Статус заявок helpdesk',
  hd_rule: 'Правило автоназначения',
  hd_requester: 'Сотрудник сайта заявок',
  calendar_colors: 'Цвета календаря',
  calendar_category_deleted: 'Удалена категория задач',
  inventory_user: 'Права читателя инвентаря',
};

const ipOf = (req) => (req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;

/**
 * Записать событие. who — req (берётся пользователь и IP) или { id, username } для фоновых заданий.
 * Ошибки журнала не мешают основному действию.
 */
async function log(who, action, object = null, details = {}) {
  try {
    const u = who && (who.portalUser || who.user || (who.id || who.username ? who : null));
    await query(
      'INSERT INTO audit_log (user_id, username, action, object, details, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [u && u.id ? u.id : null, (u && u.username) || (details && details.username) || null, action,
        object ? String(object).slice(0, 300) : null, JSON.stringify(details || {}), who && who.ip !== undefined ? ipOf(who) : null]);
  } catch (e) {
    console.error('Журнал действий:', e.message);
  }
}

module.exports = { log, ACTIONS };

/**
 * Промежуточный обработчик: успешные изменяющие запросы, подходящие под rules, пишутся в журнал.
 * rules — [[регулярное выражение пути, действие]]; объект — название из тела запроса или id из адреса.
 */
function trackChanges(rules) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const rule = rules.find(([re]) => re.test(req.path));
    if (!rule) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const b = req.body || {};
      const what = { POST: 'добавлено', PUT: 'изменено', PATCH: 'изменено', DELETE: 'удалено' }[req.method];
      const name = b.name || b.full_name || b.label || b.title || (req.path.match(/\/(\d+)/) || [])[1] || '';
      log(req, rule[1], [what, name].filter(Boolean).join(': '), { path: req.originalUrl.split('?')[0] });
    });
    next();
  };
}

module.exports.trackChanges = trackChanges;
