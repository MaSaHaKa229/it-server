// Состояние приложения, кэш справочников и редакторы полей
import { h, api, combobox, setStatuses } from './ui.js';

export const state = { me: null, perms: null, meta: null };

export const isStaff = () => state.me && ['superadmin', 'editor'].includes(state.me.role);
export const isSuper = () => state.me && state.me.role === 'superadmin';

export async function loadMeta() {
  state.meta = await api.get('/api/meta');
  setStatuses(state.meta.statuses);
  return state.meta;
}
export const typeById = (id) => state.meta.types.find((t) => t.id === Number(id));

// ---------- кэш справочников ----------
const cache = new Map();
export async function lookupItems(kind) {
  if (!cache.has(kind)) {
    cache.set(kind, api.get('/api/lookups?kind=' + encodeURIComponent(kind))
      .then((rows) => rows.map((r) => ({ id: r.id, label: r.value })))
      .catch((e) => { cache.delete(kind); throw e; }));
  }
  return cache.get(kind);
}
export async function createLookup(kind, value) {
  const r = await api.post('/api/lookups', { kind, value });
  cache.delete(kind);
  return { id: r.id, label: r.value };
}
export const invalidateLookups = (kind) => (kind ? cache.delete(kind) : cache.clear());

let swCache = null;
export async function softwareItems() {
  if (!swCache) swCache = api.get('/api/software').then((r) => r.map((s) => ({ id: s.id, label: s.name, sub: s.vendor || '', vendor: s.vendor, extra: s.extra || {} })))
    .catch((e) => { swCache = null; throw e; });
  return swCache;
}
export const invalidateSoftware = () => { swCache = null; };

// ---------- описания полей ----------
/** Описание доп. поля в едином формате */
export const customDesc = (d) => ({
  key: 'f_' + d.id, id: d.id, label: d.label, kind: d.field_type, options: d.options || [],
  lookup: d.lookup_kind, scope: d.scope, type_id: d.type_id, device_id: d.device_id, custom: true,
});

/** Доп. поля ПО: target = 'software' (программа в справочнике) | 'install' (установка на устройстве) */
export const softwareFields = (target) => (state.meta.softwareFieldDefs || [])
  .filter((d) => d.target === target)
  .map((d) => ({ ...customDesc(d), key: 'sf_' + d.id, target: d.target }));

/** Базовые поля, применимые к типу (без specs/notes — они выводятся отдельно) */
export function coreFieldsForType(typeId, { withText = false } = {}) {
  const t = typeById(typeId);
  const allowed = t ? t.fields : null;
  return state.meta.coreFields.filter((f) =>
    (withText || (f.key !== 'specs' && f.key !== 'notes')) &&
    (f.key === 'notes' || !allowed || allowed.includes(f.key)));
}

/** Доп. поля (all/type) для типа */
export function customFieldsForType(typeId) {
  return state.meta.fieldDefs
    .filter((d) => d.scope === 'all' || (d.scope === 'type' && d.type_id === Number(typeId)))
    .map(customDesc);
}

/** Значение поля устройства для отображения */
export function displayValue(desc, dev) {
  if (!desc.custom) return dev[desc.key] ?? '';
  const v = dev.extra ? dev.extra[desc.id] : null;
  if (v == null || v === '') return '';
  if (desc.kind === 'bool') return v === 'true' ? 'Да' : 'Нет';
  if (desc.kind === 'date') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU');
  }
  return v;
}

/**
 * Редактор поля.
 * Возвращает { el, focus(), patch() } — patch() даёт объект для PATCH/POST.
 */
export function fieldEditor(desc, dev = {}, { autofocus = false } = {}) {
  const staff = isStaff();
  if (!desc.custom) {
    if (desc.kind === 'lookup') {
      const cur = dev[desc.col] ? { id: dev[desc.col], label: dev[desc.key] } : null;
      const cb = combobox({
        value: cur, autofocus,
        placeholder: 'Выберите или введите новое…',
        load: () => lookupItems(desc.lookup),
        create: staff ? (text) => createLookup(desc.lookup, text) : null,
      });
      return { el: cb.el, focus: () => cb.input.focus(), patch: () => ({ [desc.col]: cb.get() ? cb.get().id : null }) };
    }
    const el = desc.kind === 'textarea'
      ? h('textarea', { rows: 4 }, dev[desc.key] || '')
      : h('input', { type: 'text', value: dev[desc.key] || '' });
    if (desc.kind === 'textarea') el.value = dev[desc.key] || '';
    if (autofocus) setTimeout(() => el.focus(), 30);
    return { el, focus: () => el.focus(), patch: () => ({ [desc.key]: el.value }) };
  }

  const cur = dev.extra ? dev.extra[desc.id] ?? '' : '';
  const wrapPatch = (get) => () => ({ extra: { [desc.id]: get() } });
  let el, get;
  switch (desc.kind) {
    case 'textarea':
      el = h('textarea', { rows: 3 }); el.value = cur; get = () => el.value; break;
    case 'number':
      el = h('input', { type: 'text', inputmode: 'decimal', value: cur }); get = () => el.value; break;
    case 'date':
      el = h('input', { type: 'date', value: cur }); get = () => el.value; break;
    case 'bool':
      el = h('select',
        h('option', { value: '' }, '—'),
        h('option', { value: 'true', selected: cur === 'true' }, 'Да'),
        h('option', { value: 'false', selected: cur === 'false' }, 'Нет'));
      get = () => el.value; break;
    case 'select':
      el = h('select', h('option', { value: '' }, '—'),
        desc.options.map((o) => h('option', { value: o, selected: o === cur }, o)));
      get = () => el.value; break;
    case 'lookup': {
      const cb = combobox({
        value: cur ? { id: cur, label: cur } : null, autofocus,
        placeholder: 'Выберите или введите новое…',
        load: () => lookupItems(desc.lookup),
        create: staff ? (text) => createLookup(desc.lookup, text) : null,
      });
      return { el: cb.el, focus: () => cb.input.focus(), patch: wrapPatch(() => (cb.get() ? cb.get().label : '')) };
    }
    default:
      el = h('input', { type: 'text', value: cur }); get = () => el.value;
  }
  if (autofocus) setTimeout(() => el.focus(), 30);
  return { el, focus: () => el.focus(), patch: wrapPatch(get) };
}

export const FIELD_TYPE_LABELS = {
  text: 'Текст', textarea: 'Многострочный текст', number: 'Число', date: 'Дата',
  bool: 'Да / Нет', select: 'Выбор из списка', lookup: 'Справочник',
};
