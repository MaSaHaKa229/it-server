// Общие функции удалённого доступа: настройки, агенты, сопоставление с техникой инвентаря
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { poolFor } = require('../db');

const db = poolFor('public');
const query = (text, params) => db.query(text, params);

const DEFAULTS = {
  consent: 'ask',        // ask — спрашивать пользователя, notify — только уведомлять
  allow_silent: false,   // разрешить администраторам удалённого доступа подключаться без уведомления
  agent_port: 5960,
  token_ttl: 60,         // секунд на то, чтобы просмотрщик открылся и подключился
};
const ONLINE_SEC = 90;   // агент «в сети», если отзывался за последние 90 с (пульс раз в 30 с)

async function migrate() {
  await query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Код регистрации агентов — создаётся один раз
  await query(`INSERT INTO remote.settings (key, value) VALUES ('registration_code', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(newCode())]);
  await require('./keys').ensureKey(db);
}

/** Код регистрации: 12 символов без похожих букв, группами по 4 */
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += A[b[i] % A.length] + (i % 4 === 3 && i < 11 ? '-' : '');
  return s;
}

async function getSettings() {
  const { rows } = await query(`SELECT key, value FROM remote.settings WHERE key <> 'signing_key'`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    consent: ['ask', 'notify'].includes(s.consent) ? s.consent : DEFAULTS.consent,
    allow_silent: typeof s.allow_silent === 'boolean' ? s.allow_silent : DEFAULTS.allow_silent,
    agent_port: Number.isInteger(s.agent_port) ? s.agent_port : DEFAULTS.agent_port,
    token_ttl: Number.isInteger(s.token_ttl) ? s.token_ttl : DEFAULTS.token_ttl,
    registration_code: s.registration_code || '',
  };
}

async function setSetting(key, value) {
  await query(`INSERT INTO remote.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]);
}

const normMac = (m) => {
  const hex = String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 && hex !== '000000000000' ? hex : null;
};
const list = (v, max = 16) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => Number(n) <= 255);

/**
 * Найти технику инвентаря для агента: по сетевому имени, затем по MAC, затем по IP.
 * Привязываем, только если совпадение единственное.
 */
async function matchDevice(agent) {
  const name = String(agent.computer_name || '').split('.')[0].toLowerCase();
  const tries = [
    name && [`lower(split_part(hostname, '.', 1)) = $1`, [name]],
    agent.macs.length && [`lower(regexp_replace(coalesce(mac_address, ''), '[^0-9a-fA-F]', '', 'g')) = ANY($1)`, [agent.macs]],
    agent.ips.length && [`trim(ip_address) = ANY($1)`, [agent.ips]],
  ].filter(Boolean);
  for (const [where, params] of tries) {
    const { rows } = await query(`SELECT id FROM public.devices WHERE ${where} LIMIT 2`, params);
    if (rows.length === 1) return rows[0].id;
  }
  return null;
}

/** Адрес, по которому просмотрщику подключаться к агенту */
function agentHost(a) {
  const ips = (a.ips || []).filter((ip) => isIPv4(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  if (a.seen_ip && isIPv4(a.seen_ip) && !a.seen_ip.startsWith('127.') && (ips.length === 0 || ips.includes(a.seen_ip))) return a.seen_ip;
  return ips[0] || a.seen_ip || a.computer_name;
}

/** Адрес клиента: за nginx — из X-Real-IP (nginx на том же компьютере) */
function clientIp(req) {
  const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if ((raw === '127.0.0.1' || raw === '::1') && req.get('x-real-ip')) return String(req.get('x-real-ip')).trim();
  return raw;
}

const AGENT_SELECT = `
  SELECT a.id, a.computer_name, a.os, a.version, a.port, a.fingerprint, a.ips, a.macs, a.seen_ip, a.windows_user,
         a.device_id, a.device_manual, a.registered_at, a.last_seen,
         (a.last_seen > now() - interval '${ONLINE_SEC} seconds') AS online,
         dt.code || '-' || d.id AS device_key, d.hostname AS device_hostname, d.inv_number AS device_inv,
         e.value AS device_employee, l.value AS device_location
    FROM remote.agents a
    LEFT JOIN public.devices d ON d.id = a.device_id
    LEFT JOIN public.device_types dt ON dt.id = d.type_id
    LEFT JOIN public.lookups e ON e.id = d.employee_id
    LEFT JOIN public.lookups l ON l.id = d.location_id`;

module.exports = {
  db, query, migrate, getSettings, setSetting, newCode, normMac, list, isIPv4, matchDevice, agentHost, clientIp,
  AGENT_SELECT, ONLINE_SEC, DEFAULTS,
};
