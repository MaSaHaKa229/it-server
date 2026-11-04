export const DOC_TYPES = {
  law: 'Закон',
  gost: 'ГОСТ',
  decree: 'Указ',
  regulation: 'Регламент',
  other: 'Прочее',
};

export const DOC_STATUSES = {
  active: 'Действует',
  inactive: 'Утратил силу',
  draft: 'Проект',
};

export const ROLES = {
  superadmin: 'Суперадмин',
  editor: 'Редактор',
  reader: 'Читатель',
};

export const EDITOR_ROLES = ['superadmin', 'editor'];
export const canEdit = (user) => Boolean(user && EDITOR_ROLES.includes(user.role));

export function formatDate(value) {
  if (!value) return '';
  const d = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString('ru-RU');
}

export function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
