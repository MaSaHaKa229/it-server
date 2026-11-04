// Модули портала и уровни доступа к ним.
// Права хранятся в users.modules (JSONB), суперадмин имеет полный доступ ко всему.

const MODULES = {
  inventory: {
    label: 'ИТ-инвентарь',
    levels: { none: 'Нет доступа', view: 'Просмотр', edit: 'Редактирование' },
  },
  docs: {
    label: 'Документы',
    levels: { none: 'Нет доступа', view: 'Просмотр', edit: 'Редактирование' },
  },
  calendar: {
    label: 'Задачи и календарь',
    levels: { none: 'Нет доступа', view: 'Просмотр', edit: 'Редактирование', admin: 'Администратор' },
  },
  helpdesk: {
    label: 'Заявки (Helpdesk)',
    levels: { none: 'Нет доступа', executor: 'Исполнитель', admin: 'Администратор' },
  },
};

// Виды документов реестра (для ограничения просмотра)
const DOC_TYPES = {
  law: 'Закон', gost: 'ГОСТ', decree: 'Указ', regulation: 'Регламент', other: 'Прочее',
};

const order = (mod) => Object.keys(MODULES[mod].levels);
const top = (mod) => order(mod)[order(mod).length - 1];

/** Уровень доступа пользователя к модулю */
function level(u, mod) {
  if (!u || !MODULES[mod]) return 'none';
  if (u.role === 'superadmin') return top(mod);
  const v = u.modules && u.modules[mod];
  return order(mod).includes(v) ? v : 'none';
}

/** Уровень не ниже заданного */
function atLeast(u, mod, min) {
  return order(mod).indexOf(level(u, mod)) >= order(mod).indexOf(min);
}

/** Привести присланные права к допустимому виду */
function normalizeModules(m) {
  m = m && typeof m === 'object' ? m : {};
  const out = {};
  for (const mod of Object.keys(MODULES)) out[mod] = order(mod).includes(m[mod]) ? m[mod] : 'none';
  // Ограничения внутри модулей
  out.docs_types = Array.isArray(m.docs_types)
    ? m.docs_types.filter((t) => Object.prototype.hasOwnProperty.call(DOC_TYPES, t))
    : null;
  out.calendar_own_only = !!m.calendar_own_only;
  return out;
}

/** Права пользователя в удобном для фронтенда виде */
function summary(u) {
  const res = {};
  for (const mod of Object.keys(MODULES)) res[mod] = level(u, mod);
  return res;
}

const requireModule = (mod, min = order(mod)[1]) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (!atLeast(req.user, mod, min)) {
    return res.status(403).json({ error: `Нет доступа к разделу «${MODULES[mod].label}»` });
  }
  next();
};

module.exports = { MODULES, DOC_TYPES, level, atLeast, normalizeModules, summary, requireModule };
