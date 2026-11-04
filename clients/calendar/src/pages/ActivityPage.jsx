import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { fmtDateTime } from '../dates.js';
import { initials, ROLES, STATUSES } from '../constants.js';

const ENTITY = { task: 'задачу', user: 'пользователя', category: 'категорию' };
const VERB = { create: 'создал(а)', update: 'изменил(а)', delete: 'удалил(а)', comment: 'прокомментировал(а)', login: 'вошёл(ла) в систему' };

function describe(a) {
  if (a.action === 'login') return VERB.login;
  const d = a.details || {};
  let s = `${VERB[a.action] || a.action} ${ENTITY[a.entity] || a.entity}`;
  const name = d.title || d.name;
  if (name) s += ` «${name}»`;
  if (d.duplicated_from) s += ' (копия)';
  if (d.fields?.length) s += `: ${d.fields.join(', ')}`;
  if (d.status && a.entity === 'task') s += ` → ${STATUSES[d.status]?.label}`;
  if (d.role) s += ` → ${ROLES[d.role]?.label}`;
  if (d.is_active === false) s += ' — заблокирован';
  if (d.password_reset) s += ' — сброшен пароль';
  return s;
}

export default function ActivityPage() {
  const { toast } = useApp();
  const [items, setItems] = useState(null);
  const [hideLogins, setHideLogins] = useState(true);

  useEffect(() => { api.get('/activity?limit=300').then((d) => setItems(d.activity)).catch((e) => toast(e.message, 'err')); }, [toast]);

  const list = (items || []).filter((a) => !hideLogins || a.action !== 'login');
  return (
    <div className="page narrow">
      <header className="page-head row">
        <div><h2>Журнал действий</h2><p className="muted">Кто и что менял в календаре</p></div>
        <label className="check"><input type="checkbox" checked={hideLogins} onChange={(e) => setHideLogins(e.target.checked)} /> Скрыть входы</label>
      </header>
      {!items ? <div className="spinner" /> : (
        <div className="card flush">
          {list.map((a) => (
            <div key={a.id} className="activity-row">
              <span className="avatar sm" style={{ background: a.user_color || '#94a3b8' }}>{initials(a.user_name || '?')}</span>
              <div><b>{a.user_name || 'Удалённый пользователь'}</b> {describe(a)}</div>
              <small className="muted">{fmtDateTime(a.created_at)}</small>
            </div>
          ))}
          {!list.length && <p className="muted pad">Записей нет</p>}
        </div>
      )}
    </div>
  );
}
