// Тонкая обёртка над fetch. Вход общий для всего портала (cookie сессии).
export function goLogin() {
  window.location.href = '/login?next=' + encodeURIComponent('/calendar/' + window.location.hash);
}

export async function logoutPortal() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'portal' }, credentials: 'same-origin' }).catch(() => {});
  window.location.href = '/login';
}

async function request(method, url, body) {
  const res = await fetch('/calendar/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'portal' } : { 'X-Requested-With': 'portal' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.details?.[0]?.message || data?.error || `Ошибка ${res.status}`);
    err.status = res.status;
    if (res.status === 401) goLogin();
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v instanceof Date ? v.toISOString() : String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
};
