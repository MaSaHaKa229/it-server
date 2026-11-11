// Уведомления на сайте (колокольчик в шапке): события и состояния, настройки каждого пользователя.
const express = require('express');
const { query } = require('../inventory/db');
const { isStaff } = require('../inventory/access');
const { HttpError, ah } = require('../inventory/util');
const N = require('./notify');
const mail = require('./mail');

const router = express.Router();
router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' })));

async function fullUser(id) {
  const { rows } = await query(
    'SELECT id, username, full_name, email, role, is_active, permissions, modules, notify_prefs FROM users WHERE id = $1', [id]);
  return rows[0];
}

const kindsFor = (u) => {
  const p = N.prefsOf(u);
  return N.KINDS.filter((k) => k.avail(u)).map((k) => ({ key: k.key, group: k.group, label: k.label, computed: !!k.computed, ...p[k.key] }));
};

// Список: непрочитанные события + состояния; прочитанные события за 14 дней — ниже
router.get('/', ah(async (req, res) => {
  const u = await fullUser(req.user.id);
  const [stored, computed, th] = await Promise.all([
    query(`SELECT id, kind, title, body AS text, link, created_at AS at, read_at IS NOT NULL AS read
             FROM notifications WHERE user_id = $1 AND (read_at IS NULL OR created_at > now() - interval '14 days')
            ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT 100`, [u.id]),
    N.computed(u, 'site'),
    N.thresholds(),
  ]);
  const sup = require('../inventory/netprobe/supplies');
  res.json({
    kinds: kindsFor(u),
    mail: { enabled: mail.enabled(), email: u.email || '' },
    events: stored.rows,
    states: computed,
    unread: stored.rows.filter((x) => !x.read).length + computed.length,
    thresholds: th,
    supply_threshold: (await sup.threshold().catch(() => null)),
    canRefresh: isStaff(u),
  });
}));

// Только счётчик (для колокольчика, раз в минуту)
router.get('/count', ah(async (req, res) => {
  const u = await fullUser(req.user.id);
  const [{ rows }, computed] = await Promise.all([
    query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]),
    N.computed(u, 'site'),
  ]);
  res.json({ unread: rows[0].n + computed.length, critical: computed.some((x) => x.level === 'critical') });
}));

// Отметить прочитанными: {ids:[...]} или {all:true}
router.post('/read', ah(async (req, res) => {
  const b = req.body || {};
  if (b.all) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  else {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0);
    if (ids.length) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.user.id, ids]);
  }
  res.json({ ok: true });
}));

// Настройки: { kind: {site, email} } (старый формат { printer_supplies: bool } тоже принимается)
router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const u = await fullUser(req.user.id);
  const cur = N.prefsOf(u);
  let changed = false;
  for (const [k, v] of Object.entries(b)) {
    if (!N.KIND[k]) continue;
    if (typeof v === 'boolean') cur[k] = { ...cur[k], site: v };
    else if (v && typeof v === 'object') cur[k] = { site: v.site !== undefined ? !!v.site : cur[k].site, email: v.email !== undefined ? !!v.email : cur[k].email };
    changed = true;
  }
  if (!changed) throw new HttpError(400, 'Нет изменений');
  await query('UPDATE users SET notify_prefs = $2::jsonb WHERE id = $1', [u.id, JSON.stringify(cur)]);
  res.json({ ok: true, kinds: kindsFor({ ...u, notify_prefs: cur }) });
}));

// Проверить расходники сейчас (редакторы и администратор инвентаря)
router.post('/refresh', ah(async (req, res) => {
  if (!isStaff(req.user)) throw new HttpError(403, 'Недостаточно прав');
  res.json(await require('../inventory/netprobe/supplies').pollAll());
}));

module.exports = router;
