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

// ---------- Раскраска ----------
// Как раскрашивать задачи и отсутствия — личная настройка пользователя (хранится в браузере)
export const COLOR_MODES = {
  tasks: { category: 'по категории', assignee: 'по исполнителю', priority: 'по приоритету', status: 'по статусу' },
  absences: { kind: 'по виду отсутствия', user: 'по цвету сотрудника' },
};
const MODE = { tasks: 'category', absences: 'kind' };
export const setColorModes = (m) => Object.assign(MODE, m);
const DEFAULT_TASK = '#64748b';

/** Цвет задачи: свой цвет задачи, иначе — по выбранной раскраске */
export function taskColor(t) {
  if (t.color) return t.color;
  if (MODE.tasks === 'assignee') return t.assignees?.[0]?.color || DEFAULT_TASK;
  if (MODE.tasks === 'priority') return PRIORITIES[t.priority]?.color || DEFAULT_TASK;
  if (MODE.tasks === 'status') return STATUSES[t.status]?.color || DEFAULT_TASK;
  return t.category_color || DEFAULT_TASK;
}
/** Цвет отсутствия: по виду или цвет сотрудника */
export const absenceColor = (a) => (MODE.absences === 'user' && a.user_color ? a.user_color : (ABSENCE_KINDS[a.kind] || ABSENCE_KINDS.other).color);

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

// Виды отсутствий сотрудников
export const ABSENCE_KINDS = {
  vacation: { label: 'Отпуск', color: '#00875A' },
  sick: { label: 'Больничный', color: '#DE350B' },
  trip: { label: 'Командировка', color: '#6554C0' },
  dayoff: { label: 'Отгул', color: '#FF8B00' },
  other: { label: 'Другое', color: '#5E6C84' },
};

// Периодичность регулярных задач (месяцев между повторами)
// Регулярные задачи: помесячные (months) и по дням (days; weekdays — дни недели 1 = пн … 7 = вс)
export const FREQS = {
  daily: { label: 'Каждый день', days: 1 },
  workdays: { label: 'По будням (пн–пт)', days: 1, weekdays: [1, 2, 3, 4, 5] },
  weekly: { label: 'Каждую неделю', days: 7, pickDays: true },
  biweekly: { label: 'Через неделю', days: 14, pickDays: true },
  monthly: { label: 'Каждый месяц', months: 1 },
  quarterly: { label: 'Каждый квартал', months: 3 },
  halfyear: { label: 'Каждые полгода', months: 6 },
  yearly: { label: 'Каждый год', months: 12 },
};
export const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const freqByMonths = (m) => Object.keys(FREQS).find((k) => FREQS[k].months === m);
/** Подпись частоты: по ключу ('weekly') или, для старых данных, по числу месяцев; weekdays — уточнение для недель */
export const freqLabel = (x, weekdays) => {
  const key = typeof x === 'number' ? freqByMonths(x) : x;
  const base = FREQS[key]?.label || '';
  if (FREQS[key]?.pickDays && weekdays?.length) return `${base} (${weekdays.map((d) => WEEKDAYS[d - 1]).join(', ')})`;
  return base;
};

// Вид задачи (для фильтра)
export const SOURCES = {
  plain: 'Обычные',
  series: 'Регулярные',
  helpdesk: 'Из заявок',
};

// Цвета по умолчанию — чтобы можно было вернуть после настройки
export const DEFAULT_COLORS = {
  absence: Object.fromEntries(Object.entries(ABSENCE_KINDS).map(([k, v]) => [k, v.color])),
  priority: Object.fromEntries(Object.entries(PRIORITIES).map(([k, v]) => [k, v.color])),
  status: Object.fromEntries(Object.entries(STATUSES).map(([k, v]) => [k, v.color])),
};
const GROUPS = { absence: ABSENCE_KINDS, priority: PRIORITIES, status: STATUSES };
/** Применить цвета, заданные администратором (поверх цветов по умолчанию) */
export function applyColors(colors = {}) {
  for (const [g, list] of Object.entries(GROUPS)) {
    for (const k of Object.keys(list)) list[k].color = colors[g]?.[k] || DEFAULT_COLORS[g][k];
  }
}
