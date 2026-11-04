import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ROLES } from '../constants.js';

export default function Profile() {
  const { user } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setMsg(null);
    if (form.next !== form.repeat) return setMsg({ error: 'Пароли не совпадают' });
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: form.current, new_password: form.next },
      });
      setForm({ current: '', next: '', repeat: '' });
      setMsg({ ok: 'Пароль изменён' });
    } catch (err) {
      setMsg({ error: err.message });
    }
  }

  return (
    <div className="card narrow">
      <h1>Профиль</h1>
      <dl className="info">
        <dt>Логин</dt><dd>{user.username}</dd>
        <dt>ФИО</dt><dd>{user.full_name || '—'}</dd>
        <dt>Роль</dt><dd>{ROLES[user.role]}</dd>
      </dl>
      <h3>Смена пароля</h3>
      <p className="muted">Пароль общий для всего портала.</p>
      <form onSubmit={submit}>
        {msg?.error && <div className="alert">{msg.error}</div>}
        {msg?.ok && <div className="alert alert-ok">{msg.ok}</div>}
        <label className="field"><span>Текущий пароль</span>
          <input className="input" type="password" value={form.current} onChange={set('current')} required />
        </label>
        <label className="field"><span>Новый пароль</span>
          <input className="input" type="password" value={form.next} onChange={set('next')} minLength={8} required />
        </label>
        <label className="field"><span>Повторите новый пароль</span>
          <input className="input" type="password" value={form.repeat} onChange={set('repeat')} minLength={8} required />
        </label>
        <button className="btn btn-primary">Сменить пароль</button>
      </form>
    </div>
  );
}
