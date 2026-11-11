import { makeApi } from '/shared/ui.js';

const api = makeApi('');
const form = document.getElementById('form');
const err = document.getElementById('err');
const next = new URLSearchParams(location.search).get('next') || '/';
const safe = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';

// Подсказка для сотрудников не из службы ИТ — сайт заявок на соседнем порту
api.get('/api/auth/config').then((c) => {
  if (!c.helpdeskPort && !c.helpdeskUrl) return;
  const url = c.helpdeskUrl || `${location.protocol}//${location.hostname}:${c.helpdeskPort}/`;
  const hd = document.getElementById('hd');
  hd.append('Не из службы ИТ? Оставить заявку в службу ИТ: ');
  const a = document.createElement('a'); a.href = url; a.textContent = url.replace(/^https?:\/\//, ''); hd.append(a);
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button');
  btn.disabled = true;
  err.classList.add('hidden');
  try {
    await api.post('/api/auth/login', { username: form.username.value, password: form.password.value });
    location.href = safe;
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});
