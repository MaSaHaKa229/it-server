// Уведомления по почте (работают, только если в .env настроен SMTP)
const L = require('./lib');

const { query } = L;

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

async function userEmail(id) {
  if (!id) return null;
  const { rows } = await query('SELECT email FROM public.users WHERE id = $1 AND is_active', [id]);
  return rows[0] && rows[0].email;
}

const staffLink = (id) => `${L.portalUrl()}/helpdesk/#/tickets/${id}`;
const userLink = (id) => `${L.helpdeskUrl()}/#/tickets/${id}`;

async function ticketCreated(id) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  const text = `Новая заявка #${t.id}: ${t.title}\n` +
    `Вид: ${t.category_name || '—'}\nОт: ${t.requester_name} (${t.requester_email})` +
    `${t.requester_department ? ', ' + t.requester_department : ''}\nМесто: ${t.location || '—'}\n\n` +
    `${t.description || ''}\n\n${staffLink(t.id)}`;
  const to = new Set(await adminEmails());
  const assignee = await userEmail(t.assignee_id);
  if (assignee) to.add(assignee);
  for (const addr of to) await L.sendMail(addr, `Новая заявка #${t.id}: ${t.title}`, text);
  await L.sendMail(t.requester_email, `Заявка #${t.id} принята`,
    `Здравствуйте, ${t.requester_name}!\n\nВаша заявка «${t.title}» зарегистрирована под номером #${t.id}.\n` +
    `Следить за ходом выполнения: ${userLink(t.id)}`);
}

async function requesterCommented(id, body) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  const to = (await userEmail(t.assignee_id)) || null;
  const list = to ? [to] : await adminEmails();
  for (const addr of list) {
    await L.sendMail(addr, `Заявка #${t.id}: новый комментарий заявителя`,
      `${t.requester_name} пишет:\n\n${body || '(приложен файл)'}\n\n${staffLink(t.id)}`);
  }
}

async function staffCommented(id, body) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  await L.sendMail(t.requester_email, `Заявка #${t.id}: ответ ИТ-отдела`,
    `Здравствуйте, ${t.requester_name}!\n\nПо заявке «${t.title}» новый комментарий:\n\n${body}\n\n${userLink(t.id)}`);
}

async function statusChanged(id) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  await L.sendMail(t.requester_email, `Заявка #${t.id}: статус «${t.status_name}»`,
    `Здравствуйте, ${t.requester_name}!\n\nСтатус заявки «${t.title}» изменён на «${t.status_name}».\n\n${userLink(t.id)}`);
}

async function assigned(id) {
  if (!L.mailEnabled()) return;
  const t = await ticket(id);
  const to = await userEmail(t.assignee_id);
  if (to) {
    await L.sendMail(to, `Вам назначена заявка #${t.id}: ${t.title}`,
      `Заявитель: ${t.requester_name}${t.requester_department ? ', ' + t.requester_department : ''}\n` +
      `Место: ${t.location || '—'}\nСрок: ${t.due_at ? new Date(t.due_at).toLocaleString('ru-RU') : 'не задан'}\n\n` +
      `${t.description || ''}\n\n${staffLink(t.id)}`);
  }
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
