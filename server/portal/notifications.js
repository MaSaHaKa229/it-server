// Уведомления на сайте (колокольчик в шапке): сейчас — расходники принтеров и МФУ.
// Каждый пользователь может отключить их у себя (users.notify_prefs.printer_supplies = false).
const express = require('express');
const { query } = require('../inventory/db');
const { perms, isStaff } = require('../inventory/access');
const { level } = require('./modules');
const { HttpError, ah } = require('../inventory/util');
const supplies = require('../inventory/netprobe/supplies');

const router = express.Router();
router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' })));

const prefsOf = (u) => ({ printer_supplies: true, ...(u.notify_prefs || {}) });

router.get('/', ah(async (req, res) => {
  const { rows } = await query('SELECT notify_prefs FROM users WHERE id = $1', [req.user.id]);
  const prefs = prefsOf(rows[0] || {});
  const canInventory = level(req.user, 'inventory') !== 'none';
  let items = [];
  let threshold = null;
  if (canInventory) {
    const r = await supplies.supplyAlerts(perms(req.user));
    threshold = r.threshold;
    if (prefs.printer_supplies) items = r.items;
  }
  res.json({ prefs, available: { printer_supplies: canInventory }, threshold, items, canRefresh: isStaff(req.user) });
}));

router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('printer_supplies' in b) patch.printer_supplies = !!b.printer_supplies;
  if (!Object.keys(patch).length) throw new HttpError(400, 'Нет изменений');
  await query('UPDATE users SET notify_prefs = notify_prefs || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(patch)]);
  res.json({ ok: true });
}));

// Проверить расходники сейчас (редакторы и администратор инвентаря)
router.post('/refresh', ah(async (req, res) => {
  if (!isStaff(req.user)) throw new HttpError(403, 'Недостаточно прав');
  res.json(await supplies.pollAll());
}));

module.exports = router;
