// Запросы к API реестра документов. Вход общий для всего портала (cookie сессии).
const BASE = '/docs/api';

export function goLogin() {
  window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
}

/**
 * Запрос к API. body — JSON, form — FormData (для файлов).
 */
export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { 'X-Requested-With': 'portal' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, credentials: 'same-origin' });

  if (res.status === 401) goLogin();

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

/** Скачивание файла */
export async function downloadFile(path, filename) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Не удалось скачать файл');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Выход из портала */
export async function logoutPortal() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'portal' }, credentials: 'same-origin' }).catch(() => {});
  window.location.href = '/login';
}
