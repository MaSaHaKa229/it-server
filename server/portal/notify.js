// Уведомления портала (колокольчик в шапке и письма на почту).
//
// Два вида:
//  • события — сохраняются в public.notifications (новая заявка, назначили задачу, комментарий…);
//  • состояния — считаются при запросе (срок заявки/задачи, расходники принтеров, гарантия, техника не в сети,
//    инвентаризация) и пропадают сами, когда решены.
// Каждый пользователь выбирает для каждого вида: «на сайте» и «на почту» (users.notify_prefs).
const { query } = require('../inventory/db');
const { perms, isStaff } = require('../inventory/access');
const { level } = require('./modules');
const mail = require('./mail');

const hd = (u) => ['executor', 'admin'].includes(level(u, 'helpdesk'));
const hdAdmin = (u) => level(u, 'helpdesk') === 'admin';
const cal = (u) => level(u, 'calendar') !== 'none';
const inv = (u) => level(u, 'inventory') !== 'none';
const invEdit = (u) => level(u, 'inventory') === 'edit' || u.role === 'superadmin';

/** Виды уведомлений. computed — состояние (считается), иначе событие */
const KINDS = [
  // emailDefault — письма по умолчанию (как было до настроек: администраторам helpdesk о новых заявках, исполнителю — о назначении и ответах)
  { key: 'hd_new', group: 'Заявки', label: 'Новая заявка', avail: hd, emailDefault: hdAdmin },
  { key: 'hd_assigned', group: 'Заявки', label: 'Мне назначили заявку', avail: hd, emailDefault: () => true },
  { key: 'hd_reply', group: 'Заявки', label: 'Заявитель ответил в моей заявке', avail: hd, emailDefault: () => true },
  { key: 'hd_due', group: 'Заявки', label: 'Срок заявки подходит к концу или прошёл', avail: hd, computed: true },
  { key: 'task_assigned', group: 'Задачи', label: 'Мне назначили задачу', avail: cal },
  { key: 'task_comment', group: 'Задачи', label: 'Новый комментарий в моей задаче', avail: cal },
  { key: 'task_due', group: 'Задачи', label: 'Срок моей задачи завтра или прошёл', avail: cal, computed: true },
  { key: 'printer_supplies', group: 'Техника', label: 'Заканчиваются расходники принтеров и МФУ', avail: inv, computed: true },
  { key: 'stock_low', group: 'Техника', label: 'На складе мало расходника (меньше минимума)', avail: invEdit, computed: true },
  { key: 'warranty', group: 'Техника', label: 'Заканчивается гарантия или лицензия', avail: inv, computed: true },
  { key: 'device_offline', group: 'Техника', label: 'Техника давно не появлялась в сети', avail: invEdit, computed: true },
  { key: 'netscan_new', group: 'Техника', label: 'Сканирование по расписанию нашло новую технику', avail: invEdit },
  { key: 'audit', group: 'Техника', label: 'Инвентаризация: подходит дата проведения', avail: invEdit, computed: true },
  { key: 'system', group: 'Портал', label: 'Ошибки резервного копирования', avail: (u) => u.role === 'superadmin' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]));

/** Настройки пользователя u: { kind: {site, email} }. Старый формат printer_supplies: bool — «на сайте» */
function prefsOf(u) {
  const p = (u && u.notify_prefs) || {};
  const out = {};
  for (const k of KINDS) {
    const v = p[k.key];
    const emailDef = !!(k.emailDefault && u && k.emailDefault(u));
    if (typeof v === 'boolean') out[k.key] = { site: v, email: emailDef };
    else {
      out[k.key] = {
        site: v && v.site === false ? false : true,
        email: v && typeof v.email === 'boolean' ? v.email : emailDef,
      };
    }
  }
  return out;
}

// ---------------- настройки порогов (Администрирование → Уведомления) ----------------
const DEFAULTS = { warranty_days: 30, offline_days: 30, hd_due_hours: 24, audit_days: 1 };
async function thresholds() {
  try {
    const { rows } = await query(`SELECT value FROM portal_settings WHERE key = 'notify'`);
    return { ...DEFAULTS, ...((rows[0] && rows[0].value) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const portalUrl = () => (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ---------------- события ----------------

/**
 * Отправить событие пользователям: в колокольчик (если включено «на сайте») и на почту (если «на почту»).
 * users — id пользователей портала; except — кого пропустить (автор действия).
 */
async function emit(userIds, kind, { title, body = '', link = null }, except = null) {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => n > 0 && n !== Number(except)))];
  if (!ids.length || !KIND[kind]) return;
  try {
    const { rows } = await query(
      'SELECT id, username, full_name, email, role, is_active, permissions, modules, notify_prefs FROM users WHERE id = ANY($1::int[]) AND is_active', [ids]);
    for (const u of rows) {
      if (!KIND[kind].avail(u)) continue;
      const p = prefsOf(u)[kind];
      if (p.site) {
        await query('INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)',
          [u.id, kind, title.slice(0, 300), String(body || '').slice(0, 2000), link]);
      }
      if (p.email && u.email && mail.enabled()) {
        mail.send(u.email, title, `${body ? body + '\n\n' : ''}${link ? portalUrl() + link : ''}`.trim()).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Уведомления:', e.message);
  }
}

/** Пользователи по условию (для «всем исполнителям helpdesk» и т. п.) */
async function usersWhere(test) {
  const { rows } = await query('SELECT id, role, modules, permissions FROM users WHERE is_active');
  return rows.filter(test).map((u) => u.id);
}

// ---------------- состояния ----------------

const fmtDay = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

async function hdDue(u, th) {
  const admin = hdAdmin(u);
  const { rows } = await query(
    `SELECT t.id, t.title, t.due_at, t.assignee_id, (t.due_at < now()) AS over
       FROM helpdesk.tickets t JOIN helpdesk.statuses s ON s.id = t.status_id
      WHERE NOT s.is_closed AND t.due_at IS NOT NULL AND t.due_at < now() + make_interval(hours => $2::int)
        AND (t.assignee_id = $1 OR ($3 AND t.due_at < now()))
      ORDER BY t.due_at LIMIT 200`, [u.id, th.hd_due_hours, admin]);
  return rows.map((r) => ({
    kind: 'hd_due', key: `hd_due:${r.id}:${r.over ? 'over' : 'soon'}`, level: r.over ? 'critical' : 'warning',
    title: r.over ? `Просрочена заявка #${r.id}` : `Срок заявки #${r.id} подходит к концу`,
    text: `${r.title} — срок ${new Date(r.due_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`
      + (r.assignee_id !== u.id ? ' (не ваша)' : ''),
    link: `/helpdesk/#/tickets/${r.id}`, at: r.due_at,
  }));
}

async function taskDue(u) {
  const { rows } = await query(
    `SELECT t.id, t.title, t.end_at, t.all_day,
            ((CASE WHEN t.all_day THEN t.end_at + interval '1 day' ELSE t.end_at END) < now()) AS over
       FROM calendar.tasks t JOIN calendar.task_assignees a ON a.task_id = t.id AND a.user_id = $1
      WHERE t.status IN ('todo', 'in_progress')
        AND t.end_at < date_trunc('day', now()) + interval '2 days'
      ORDER BY t.end_at LIMIT 200`, [u.id]);
  return rows.map((r) => ({
    kind: 'task_due', key: `task_due:${r.id}:${r.over ? 'over' : 'soon'}`, level: r.over ? 'critical' : 'warning',
    title: r.over ? 'Просрочена задача' : 'Срок задачи — завтра или сегодня',
    text: `${r.title} — до ${r.all_day ? fmtDay(r.end_at) : new Date(r.end_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
    link: `/calendar/#/calendar?task=${r.id}`, at: r.end_at,
  }));
}

async function supplies(u) {
  const S = require('../inventory/netprobe/supplies');
  const Stock = require('../inventory/routes/stock');
  const { items } = await S.supplyAlerts(perms(u));
  const out = [];
  for (const it of items) {
    // Есть ли подходящий расходник на складе
    const st = await Stock.forSupply({ model: it.model, snmpModel: it.model }, it.supply).catch(() => []);
    const stockText = st.length ? `на складе: ${st.map((x) => `${x.name} — ${x.qty} ${x.unit}`).join(', ')}` : '';
    out.push({
      kind: 'printer_supplies', key: `supply:${it.device_id}:${it.supply}:${it.level}`, level: it.level,
      title: `${it.supply} — ${it.percent}%`, percent: it.percent,
      text: [`${it.key} ${it.title}`, it.location, it.department, stockText].filter(Boolean).join(' · '),
      link: `/inventory/#/devices/${it.device_id}`, at: it.checked_at,
    });
  }
  return out;
}

async function stockLow() {
  const rows = await require('../inventory/routes/stock').lowItems();
  return rows.map((r) => ({
    kind: 'stock_low', key: `stock:${r.id}:${r.qty}`, level: r.qty === 0 ? 'critical' : 'warning',
    title: `${r.name}: на складе ${r.qty} ${r.unit}`, text: `минимум — ${r.min_qty} ${r.unit}`,
    link: '/inventory/#/stock', at: r.last_at || r.created_at,
  }));
}

// Поля-даты, которые считаются сроком окончания гарантии/лицензии (по названию поля)
const WARRANTY_RE = '(гарант|лиценз|окончан|истека|действ|срок)';

/** Ограничение техники по правам читателя инвентаря (типы и отделы) */
function deviceScope(P, vals) {
  const w = [];
  if (P.types !== null) { vals.push(P.types); w.push(`d.type_id = ANY($${vals.length}::int[])`); }
  if (P.departments !== null) { vals.push(P.departments); w.push(`d.department_id = ANY($${vals.length}::int[])`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

async function warranty(u, th) {
  const P = perms(u);
  const vals = [th.warranty_days];
  const scope = deviceScope(P, vals);
  // Доп. поля техники (дата) и поля ПО (дата) — значения в extra: {"<id>": "ГГГГ-ММ-ДД"}
  const { rows } = await query(
    `WITH f AS (SELECT id, label FROM field_defs WHERE field_type = 'date' AND label ~* '${WARRANTY_RE}'),
          sf AS (SELECT id, label FROM software_field_defs WHERE field_type = 'date' AND label ~* '${WARRANTY_RE}'),
          v AS (
            SELECT d.id AS device_id, f.label, NULL::text AS software, d.extra->>(f.id::text) AS val
              FROM devices d JOIN f ON d.extra ? f.id::text
             WHERE d.status <> 'written_off' ${scope}
            UNION ALL
            SELECT d.id, sf.label, s.name, COALESCE(NULLIF(ds.extra->>(sf.id::text), ''), s.extra->>(sf.id::text))
              FROM device_software ds JOIN devices d ON d.id = ds.device_id JOIN software s ON s.id = ds.software_id
              JOIN sf ON (ds.extra ? sf.id::text OR s.extra ? sf.id::text)
             WHERE d.status <> 'written_off' ${scope})
     SELECT v.*, t.code AS type_code, COALESCE(NULLIF(d.hostname, ''), lm.value, t.name) AS title
       FROM v JOIN devices d ON d.id = v.device_id JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups lm ON lm.id = d.model_id
      WHERE v.val ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND v.val::date <= current_date + $1::int AND v.val::date >= current_date - 30
      ORDER BY v.val::date LIMIT 300`, vals);
  return rows.map((r) => {
    const d = r.val.slice(0, 10);
    const over = d < new Date().toISOString().slice(0, 10);
    return {
      kind: 'warranty', key: `warranty:${r.device_id}:${r.label}:${r.software || ''}:${d}`, level: over ? 'critical' : 'warning',
      title: `${r.software ? r.software + ': ' : ''}${r.label} — ${over ? 'истекла' : 'до'} ${fmtDay(d)}`,
      text: `${r.type_code}-${r.device_id} ${r.title}`, link: `/inventory/#/devices/${r.device_id}`, at: d,
    };
  });
}

async function offline(u, th) {
  const vals = [th.offline_days];
  const scope = deviceScope(perms(u), vals);
  const { rows } = await query(
    `SELECT d.id, t.code, COALESCE(NULLIF(d.hostname, ''), d.ip_address, t.name) AS title, s.last_seen,
            ll.value AS location
       FROM device_seen s JOIN devices d ON d.id = s.device_id JOIN device_types t ON t.id = d.type_id
       LEFT JOIN lookups ll ON ll.id = d.location_id
      WHERE d.status <> 'written_off' AND s.last_seen < now() - make_interval(days => $1::int) ${scope}
      ORDER BY s.last_seen LIMIT 200`, vals);
  return rows.map((r) => ({
    kind: 'device_offline', key: `offline:${r.id}:${new Date(r.last_seen).toISOString().slice(0, 10)}`, level: 'warning',
    title: `Не в сети с ${fmtDay(r.last_seen)}`, text: [`${r.code}-${r.id} ${r.title}`, r.location].filter(Boolean).join(' · '),
    link: `/inventory/#/devices/${r.id}`, at: r.last_seen,
  }));
}

async function audits(u, th) {
  const { rows } = await query(
    `SELECT a.id, a.title, to_char(a.planned_date, 'YYYY-MM-DD') AS planned_date, (a.planned_date < current_date) AS over,
            (SELECT count(*)::int FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.state = 'pending') AS left_count
       FROM inventory_audits a
      WHERE a.status = 'open' AND a.planned_date <= current_date + $1::int
      ORDER BY a.planned_date`, [th.audit_days]);
  return rows.map((r) => ({
    kind: 'audit', key: `audit:${r.id}:${r.planned_date}:${r.over ? 'over' : 'soon'}`, level: r.over ? 'critical' : 'warning',
    title: r.over ? `Инвентаризация не завершена (план — ${fmtDay(r.planned_date)})` : `Инвентаризация ${fmtDay(r.planned_date)}`,
    text: `${r.title} — не проверено: ${r.left_count}`, link: `/inventory/#/audits/${r.id}`, at: r.planned_date,
  }));
}

const COMPUTE = { hd_due: hdDue, task_due: taskDue, printer_supplies: supplies, stock_low: stockLow, warranty, device_offline: offline, audit: audits };

/** Вычисляемые уведомления пользователя по включённым видам (channel: site | email) */
async function computed(u, channel = 'site') {
  const p = prefsOf(u);
  const th = await thresholds();
  const out = [];
  for (const k of KINDS) {
    if (!k.computed || !k.avail(u) || !p[k.key][channel]) continue;
    try {
      out.push(...(await COMPUTE[k.key](u, th)));
    } catch (e) {
      console.error(`Уведомления (${k.key}):`, e.message);
    }
  }
  return out;
}

// ---------------- рассылка состояний на почту ----------------
// Раз в 15 минут: каждому, кто включил «на почту», — новые (ещё не отправленные) состояния.
async function mailComputed() {
  if (!mail.enabled()) return;
  const { rows } = await query(
    `SELECT id, username, full_name, email, role, is_active, permissions, modules, notify_prefs FROM users
      WHERE is_active AND email IS NOT NULL AND email <> ''`);
  for (const u of rows) {
    const p = prefsOf(u);
    if (!KINDS.some((k) => k.computed && p[k.key].email)) continue;
    const items = await computed(u, 'email');
    const sent = new Set((await query('SELECT key FROM notify_sent WHERE user_id = $1', [u.id])).rows.map((r) => r.key));
    const fresh = items.filter((x) => !sent.has(x.key));
    if (fresh.length) {
      const text = fresh.map((x) => `• ${x.title}\n  ${x.text}\n  ${portalUrl()}${x.link}`).join('\n\n');
      const ok = await mail.send(u.email, fresh.length === 1 ? fresh[0].title : `ИТ-портал: уведомлений — ${fresh.length}`, text);
      if (ok) {
        for (const x of fresh) await query('INSERT INTO notify_sent (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, x.key]);
      }
    }
    // Решённое забываем, чтобы при повторе пришло снова
    const keys = items.map((x) => x.key);
    await query('DELETE FROM notify_sent WHERE user_id = $1 AND NOT (key = ANY($2::text[]))', [u.id, keys]);
  }
}

function start() {
  const H = require('./health');
  H.register('notify_mail', 'Рассылка уведомлений на почту', 15);
  const run = () => H.track('notify_mail', async () => { await mailComputed(); return mail.enabled() ? 'почта настроена' : 'почта не настроена — письма не отправляются'; })
    .catch((e) => console.error('Уведомления на почту:', e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 15 * 60 * 1000).unref?.();
  // Старые прочитанные события чистим раз в сутки
  setInterval(() => query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`).catch(() => {}), 24 * 3600 * 1000).unref?.();
}

module.exports = { KINDS, KIND, prefsOf, emit, usersWhere, computed, thresholds, DEFAULTS, start, isStaff, hd, hdAdmin, _mailComputed: mailComputed };
