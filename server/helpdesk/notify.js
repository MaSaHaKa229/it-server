// Уведомления по почте (работают, только если в .env настроен SMTP)
const L = require('./lib');

const { query } = L;
// Уведомления сотрудникам службы ИТ — через общий механизм портала (колокольчик и почта по настройкам каждого)
const N = require('../portal/notify');
const staffPath = (id) => `/helpdesk/#/tickets/${id}`;

async function ticket(id) {
  return (await query(`${L.TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0];
}

// Администраторы helpdesk с e-mail (включая суперадминов портала)
async function adminEmails() {
  const { rows } = await query(
    `SELECT email FROM public.users
      WHERE is_active AND email IS NOT NULL AND email <> ''
        AND (role = 'superadmin' OR modules->>'helpdesk' = 'admin')`);
  return rows.map((r) => r.email);
}

const userLink = (id) => `${L.helpdeskUrl()}/#/tickets/${id}`;

async function ticketCreated(id, actorId = null) {
  const t = await ticket(id);
  const body = `Вид: ${t.category_name || '—'}\nОт: ${t.requester_name}${t.requester_department ? ', ' + t.requester_department : ''}`
    + `\nМесто: ${t.location || '—'}${t.description ? '\n\n' + t.description.slice(0, 500) : ''}`;
  await N.emit(await N.usersWhere(N.hd), 'hd_new', { title: `Новая заявка #${t.id}: ${t.title}`, body, link: staffPath(t.id) }, actorId);
  if (t.assignee_id) await assigned(id, actorId);
  if (!L.mailEnabled()) return;
  await L.sendMail(t.requester_email, `Заявка #${t.id} принята`,
    `Здравствуйте, ${t.requester_name}!\n\nВаша заявка «${t.title}» зарегистрирована под номером #${t.id}.\n` +
    `Следить за ходом выполнения: ${userLink(t.id)}`);
}

async function requesterCommented(id, body) {
  const t = await ticket(id);
  const to = t.assignee_id ? [t.assignee_id] : await N.usersWhere(N.hdAdmin);
  await N.emit(to, 'hd_reply', { title: `Заявка #${t.id}: ответ заявителя`, body: `${t.requester_name} пишет:\n${(body || '(приложен файл)').slice(0, 1000)}`, link: staffPath(t.id) });
}

async function staffCommented(id, body) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  await L.sendMail(t.requester_email, `Заявка #${t.id}: ответ службы ИТ`,
    `Здравствуйте, ${t.requester_name}!\n\nПо заявке «${t.title}» новый комментарий:\n\n${body}\n\n${userLink(t.id)}`);
}

async function statusChanged(id) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  await L.sendMail(t.requester_email, `Заявка #${t.id}: статус «${t.status_name}»`,
    `Здравствуйте, ${t.requester_name}!\n\nСтатус заявки «${t.title}» изменён на «${t.status_name}».\n\n${userLink(t.id)}`);
}

async function assigned(id, actorId = null) {
  const t = await ticket(id);
  if (!t.assignee_id) return;
  await N.emit([t.assignee_id], 'hd_assigned', {
    title: `Вам назначена заявка #${t.id}: ${t.title}`,
    body: `Заявитель: ${t.requester_name}${t.requester_department ? ', ' + t.requester_department : ''}\n`
      + `Место: ${t.location || '—'}\nСрок: ${t.due_at ? new Date(t.due_at).toLocaleString('ru-RU') : 'не задан'}`,
    link: staffPath(t.id),
  }, actorId);
}

async function newRequester(r) {
  if (!L.mailEnabled()) return;
  for (const addr of await adminEmails()) {
    await L.sendMail(addr, 'Helpdesk: новая регистрация ждёт подтверждения',
      `${r.full_name} (${r.email})${r.department ? ', ' + r.department : ''} зарегистрировался на сайте заявок.\n` +
      `Подтвердите регистрацию: ${L.portalUrl()}/helpdesk/#/requesters`);
  }
}

module.exports = { ticketCreated, requesterCommented, staffCommented, statusChanged, assigned, newRequester };
