export const STATUSES = {
  todo: { label: 'К выполнению', color: '#64748b' },
  in_progress: { label: 'В работе', color: '#2563eb' },
  done: { label: 'Выполнено', color: '#16a34a' },
  cancelled: { label: 'Отменено', color: '#9ca3af' },
};

export const PRIORITIES = {
  low: { label: 'Низкий', color: '#94a3b8' },
  normal: { label: 'Обычный', color: '#0ea5e9' },
  high: { label: 'Высокий', color: '#f59e0b' },
  critical: { label: 'Критичный', color: '#dc2626' },
};

export const ROLES = {
  admin: { label: 'Администратор', hint: 'Полный доступ, управление пользователями' },
  editor: { label: 'Редактор', hint: 'Создание и изменение задач' },
  viewer: { label: 'Наблюдатель', hint: 'Только просмотр календаря' },
};

export const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#64748b'];

export const isOverdue = (t) => (t.status === 'todo' || t.status === 'in_progress') && new Date(t.end_at) < new Date();

export const taskColor = (t) => t.category_color || '#64748b';

// «Иванов Иван Иванович» → «Иванов И.И.»; «Иванов И.И.» и одиночные имена — как есть
export function shortName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || /\./.test(parts[1])) return parts.join(' ');
  return parts[0] + ' ' + parts.slice(1, 3).map((p) => p[0].toUpperCase() + '.').join('');
}
/** Исполнители задачи: кратко (для плашек) и полностью (для подсказки) */
export const whoShort = (people) => (people?.length ? people.map((p) => shortName(p.name)).join(', ') : 'без исполнителя');
export const whoFull = (people) => (people?.length ? people.map((p) => p.name).join(', ') : 'Исполнитель не назначен');

export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
