// Каталог базовых полей, права доступа и middleware авторизации
const { query } = require('./db');

// Базовые поля устройства. kind: text | textarea | lookup
const CORE_FIELDS = [
  { key: 'inv_number',    label: 'Инвентарный №',   kind: 'text' },
  { key: 'hostname',      label: 'Сетевое имя',     kind: 'text' },
  { key: 'model',         label: 'Модель',          kind: 'lookup', lookup: 'model',      col: 'model_id' },
  { key: 'cpu',           label: 'Процессор',       kind: 'lookup', lookup: 'cpu',        col: 'cpu_id' },
  { key: 'ram',           label: 'ОЗУ',             kind: 'lookup', lookup: 'ram',        col: 'ram_id' },
  { key: 'storage',       label: 'Накопитель',      kind: 'lookup', lookup: 'storage',    col: 'storage_id' },
  { key: 'os',            label: 'ОС',              kind: 'lookup', lookup: 'os',         col: 'os_id' },
  { key: 'employee',      label: 'Пользователь',    kind: 'lookup', lookup: 'employee',   col: 'employee_id' },
  { key: 'department',    label: 'Отдел',           kind: 'lookup', lookup: 'department', col: 'department_id' },
  { key: 'location',      label: 'Расположение',    kind: 'lookup', lookup: 'location',   col: 'location_id' },
  { key: 'serial_number', label: 'Серийный №',      kind: 'text' },
  { key: 'ip_address',    label: 'IP-адрес',        kind: 'text' },
  { key: 'mac_address',   label: 'MAC-адрес',       kind: 'text' },
  { key: 'specs',         label: 'Прочие характеристики', kind: 'textarea' },
  { key: 'notes',         label: 'Описание / примечание', kind: 'textarea' },
];
const CORE_BY_KEY = Object.fromEntries(CORE_FIELDS.map((f) => [f.key, f]));


// Псевдо-поля, которыми суперадмин может ограничить читателя
const EXTRA_PERMISSION_FIELDS = [
  { key: 'instance_fields', label: 'Поля отдельных экземпляров' },
];

const isStaff = (u) => u && (u.role === 'superadmin' || u.role === 'editor');

/** Эффективные права пользователя */
function perms(u) {
  if (isStaff(u)) {
    return { types: null, departments: null, fields: null, passwords: true, software: true, export: true, history: true };
  }
  const p = (u && u.permissions) || {};
  const ids = (v) => v.map(Number).filter(Number.isFinite);
  return {
    // null = все, [] = ничего
    types: p.types === null ? null : Array.isArray(p.types) ? ids(p.types) : [],
    departments: Array.isArray(p.departments) ? ids(p.departments) : null,
    fields: Array.isArray(p.fields) ? p.fields.map(String) : null,
    passwords: !!p.passwords,
    software: !!p.software,
    export: p.export !== false,
    history: false,
  };
}

const canSeeField = (P, key) => P.fields === null || P.fields.includes(key);

// ---------- middleware ----------

async function loadUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  try {
    const { rows } = await query(
      'SELECT id, username, full_name, email, role, is_active, permissions, modules FROM users WHERE id = $1',
      [req.session.userId]
    );
    const u = rows[0];
    if (!u || !u.is_active) {
      req.session.destroy(() => {});
      return next();
    }
    req.user = u;
    req.perms = perms(u);
    next();
  } catch (e) {
    next(e);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
};

const requireStaff = requireRole('superadmin', 'editor');
const requireSuperadmin = requireRole('superadmin');

module.exports = {
  CORE_FIELDS, CORE_BY_KEY, EXTRA_PERMISSION_FIELDS,
  isStaff, perms, canSeeField,
  loadUser, requireAuth, requireRole, requireStaff, requireSuperadmin,
};
