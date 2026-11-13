// Оформление: название предприятия, название портала и сайта заявок, логотип (Администрирование → «Оформление»).
// Хранится в portal_settings.branding. Портал применяет его общим скриптом /shared/prefs.js,
// сайт заявок — через свою /api/config.
const express = require('express');
const { query } = require('../inventory/db');
const { HttpError, ah, str } = require('../inventory/util');

const DEF = { company: '', portal_title: 'ИТ-портал', portal_short: 'Портал', helpdesk_title: 'HelpDesk', logo: null, helpdesk_logo: true };
const MAX_LOGO = 300 * 1024; // байт в виде data:-адреса
let cache = null;

async function get() {
  if (cache && Date.now() - cache.at < 30000) return cache.v;
  const { rows } = await query(`SELECT value FROM portal_settings WHERE key = 'branding'`).catch(() => ({ rows: [] }));
  const v = { ...DEF, ...((rows[0] && rows[0].value) || {}) };
  cache = { at: Date.now(), v };
  return v;
}

/** То, что видно всем (в том числе до входа): без лишнего */
const publicView = (b) => ({ company: b.company, portal_title: b.portal_title, portal_short: b.portal_short,
  helpdesk_title: b.helpdesk_title, logo: b.logo, helpdesk_logo: b.helpdesk_logo });

// Открыто без входа — нужно странице входа
const publicRouter = express.Router();
publicRouter.get('/', ah(async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(publicView(await get()));
}));

// Изменение — администратор портала (подключается внутри /api/admin)
const adminRouter = express.Router();
adminRouter.put('/', ah(async (req, res) => {
  const b = req.body || {};
  const logo = b.logo ? String(b.logo) : null;
  if (logo) {
    if (!/^data:image\/(png|jpeg|gif|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new HttpError(400, 'Логотип: картинка PNG, JPG, GIF или SVG');
    if (logo.length > MAX_LOGO) throw new HttpError(400, 'Логотип слишком большой — нужен файл до 200 КБ');
  }
  const v = {
    company: str(b.company, 200) || '',
    portal_title: str(b.portal_title, 60) || DEF.portal_title,
    portal_short: str(b.portal_short, 30) || DEF.portal_short,
    helpdesk_title: str(b.helpdesk_title, 60) || DEF.helpdesk_title,
    logo,
    helpdesk_logo: b.helpdesk_logo !== false,
  };
  await query(`INSERT INTO portal_settings (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  cache = null;
  await require('./audit').log(req, 'branding', null, { ...v, logo: logo ? `картинка ${Math.round(logo.length / 1024)} КБ` : 'нет' });
  res.json(v);
}));

module.exports = { get, publicView, publicRouter, adminRouter, DEF };
