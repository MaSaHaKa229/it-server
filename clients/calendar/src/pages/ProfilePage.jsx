import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { initials, PALETTE, ROLES } from '../constants.js';

export default function ProfilePage() {
  const { user, setUser, toast, reloadUsers } = useApp();
  const [p, setP] = useState({ name: user.name, position: user.position || '', color: user.color });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [pwError, setPwError] = useState('');

  const saveProfile = async (e) => {
    e.preventDefault();
    try {
      const { user: u } = await api.patch('/auth/me', { ...p, position: p.position || null });
      setUser(u); reloadUsers(); toast('Профиль сохранён');
    } catch (err) { toast(err.message, 'err'); }
  };

  const changePw = async (e) => {
    e.preventDefault();
    setPwError('');
    if (pw.newPassword !== pw.repeat) return setPwError('Пароли не совпадают');
    try {
      await api.post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', repeat: '' });
      toast('Пароль изменён');
    } catch (err) { setPwError(err.message); }
  };

  return (
    <div className="page narrow">
      <header className="page-head row">
        <span className="person big">
          <span className="avatar lg" style={{ background: p.color }}>{initials(p.name)}</span>
          <span><h2>{user.name}</h2><span className="muted">{user.email} · {ROLES[user.role].label}</span></span>
        </span>
      </header>

      <form className="card task-form" onSubmit={saveProfile}>
        <h3>Профиль</h3>
        <div className="form-grid">
          <label className="field"><span>ФИО</span><input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} required /></label>
          <label className="field"><span>Должность</span><input value={p.position} onChange={(e) => setP({ ...p, position: e.target.value })} /></label>
        </div>
        <div className="field">
          <span>Цвет</span>
          <div className="swatches">
            {PALETTE.map((c) => <button type="button" key={c} className={`swatch ${p.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setP({ ...p, color: c })} />)}
          </div>
        </div>
        <div className="form-actions"><button className="btn primary">Сохранить</button></div>
      </form>

      <form className="card task-form" onSubmit={changePw}>
        <h3>Смена пароля</h3>
        <label className="field"><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></label>
        <div className="form-grid">
          <label className="field"><span>Новый пароль (от 8 символов)</span><input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></label>
          <label className="field"><span>Повторите пароль</span><input type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} required /></label>
        </div>
        {pwError && <div className="form-error">{pwError}</div>}
        <div className="form-actions"><button className="btn primary">Изменить пароль</button></div>
      </form>
    </div>
  );
}
