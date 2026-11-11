// Перемещения техники и массовое изменение полей
import { h, clear, api, toast, run, modal, combobox, typeDot, fmtDate, debounce } from '../ui.js';
import { state, isStaff, lookupItems, createLookup, fieldEditor, customDesc } from '../store.js';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (s) => (s ? s.split('-').reverse().join('.') : '');

/**
 * Окно «Переместить»: devices — [{id, ...текущие значения}] (одно устройство — показываются текущие значения).
 * onDone вызывается после перемещения.
 */
export function moveDialog(devices, onDone) {
  const one = devices.length === 1 ? devices[0] : null;
  const row = (key, label, kind) => {
    const cur = one && one[key + '_id'] ? { id: one[key + '_id'], label: one[key] } : null;
    const on = h('input', { type: 'checkbox' });
    const cb = combobox({
      value: cur, placeholder: 'Выберите или введите новое…',
      load: () => lookupItems(kind), create: (text) => createLookup(kind, text),
      onChange: () => { on.checked = true; },
    });
    return { key, on, get: () => (cb.get() ? cb.get().id : null),
      el: h('div.mv-row', h('label.check', on, label), cb.el, one ? h('div.small.muted', 'сейчас: ', one[key] || '—') : null) };
  };
  const rows = [row('location', 'Расположение', 'location'), row('employee', 'Пользователь', 'employee'), row('department', 'Отдел', 'department')];
  // Рабочее место
  const wpOn = h('input', { type: 'checkbox' });
  const wpSel = h('select', h('option', { value: '' }, '— не привязано —'));
  api.get('/api/workplaces').then((list) => {
    list.forEach((w) => wpSel.append(h('option', { value: w.id }, w.name + (w.location ? ` (${w.location})` : ''))));
    if (one && one.workplace_id) wpSel.value = String(one.workplace_id);
  }).catch(() => {});
  wpSel.addEventListener('change', () => { wpOn.checked = true; });
  const date = h('input', { type: 'date', value: today() });
  const note = h('input', { type: 'text', placeholder: 'Например: переезд отдела, служебная записка №…' });
  const save = h('button.btn.primary', 'Переместить');
  const m = modal({
    title: one ? `Переместить ${one.type_code}-${one.id} ${one.hostname || one.model || ''}` : `Переместить технику: ${devices.length} шт.`,
    body: h('div.stack', { style: { gap: '12px' } },
      h('p.hint', { style: { margin: 0 } }, 'Отметьте, что меняется. Перемещение попадёт в историю техники и в журнал «Перемещения».'),
      rows.map((r) => r.el),
      h('div.mv-row', h('label.check', wpOn, 'Рабочее место'), wpSel, one ? h('div.small.muted', 'сейчас: ', one.workplace || '—') : null),
      h('div.form-grid',
        h('label.field', h('span', 'Дата перемещения'), date),
        h('label.field', h('span', 'Основание / комментарий'), note))),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const set = {};
    for (const r of rows) if (r.on.checked) set[r.key] = r.get();
    if (wpOn.checked) set.workplace = wpSel.value ? Number(wpSel.value) : null;
    if (!Object.keys(set).length) throw new Error('Отметьте, что меняется');
    const r = await api.post('/api/moves', { ids: devices.map((d) => d.id), set, moved_on: date.value, note: note.value });
    m.close();
    toast(r.moved ? `Перемещено: ${r.moved} шт.` : 'Ничего не изменилось — значения уже такие');
    window.dispatchEvent(new Event('itdb:changed'));
    if (onDone) onDone();
  }, save));
}

/** Массовое изменение полей у выбранной техники */
export function bulkEditDialog(ids, onDone) {
  const SKIP = new Set(['inv_number', 'hostname', 'serial_number', 'ip_address', 'mac_address']); // уникальные у каждого устройства
  const core = state.meta.coreFields.filter((f) => !SKIP.has(f.key));
  const custom = state.meta.fieldDefs.filter((d) => d.scope === 'all').map(customDesc);
  const rows = [...core, ...custom].map((desc) => {
    const ed = fieldEditor(desc, {});
    const on = h('input', { type: 'checkbox' });
    ed.el.addEventListener('input', () => { on.checked = true; }, true);
    ed.el.addEventListener('change', () => { on.checked = true; }, true);
    ed.el.addEventListener('click', () => { on.checked = true; }, true);
    return { desc, on, ed, el: h('div.mv-row', h('label.check', on, desc.label), ed.el) };
  });
  const save = h('button.btn.primary', 'Изменить');
  const m = modal({
    title: `Изменить поля: ${ids.length} шт.`, size: 'wide',
    body: h('div.stack', { style: { gap: '10px' } },
      h('p.hint', { style: { margin: 0 } }, 'Отмеченные поля получат одно значение у всей выбранной техники (пустое — очистить). ',
        'Изменения попадут в историю каждой единицы. Для переезда в другой кабинет или к другому сотруднику удобнее «Переместить» — там есть дата и основание.'),
      h('div.mv-grid', rows.map((r) => r.el))),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const value = {};
    for (const r of rows) {
      if (!r.on.checked) continue;
      const p = r.ed.patch();
      if (p.extra) value.extra = { ...(value.extra || {}), ...p.extra }; else Object.assign(value, p);
    }
    if (!Object.keys(value).length) throw new Error('Отметьте поля, которые нужно изменить');
    await api.post('/api/devices/bulk', { ids, action: 'update', value });
    m.close();
    toast(`Изменено устройств: ${ids.length}`);
    window.dispatchEvent(new Event('itdb:changed'));
    if (onDone) onDone();
  }, save));
}

const STYLE = `
.mv-row { display: grid; grid-template-columns: 170px 1fr; gap: 4px 12px; align-items: center; }
.mv-row > .small { grid-column: 2; }
.mv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }
.mv-chg { font-size: 13px; }
.mv-chg .old { color: var(--text-subtle); text-decoration: line-through; }
`;
export function moveStyles() {
  if (document.getElementById('mv-style')) return;
  const s = h('style', { id: 'mv-style' }); s.textContent = STYLE; document.head.append(s);
}

// ====================== Журнал перемещений ======================
const filt = { from: '', to: '', q: '' };

export async function renderMoves(root) {
  moveStyles();
  document.title = 'Перемещения — ИТ Инвентарь';
  if (!filt.from) { const d = new Date(); d.setMonth(d.getMonth() - 3); filt.from = d.toISOString().slice(0, 10); filt.to = today(); }
  const from = h('input', { type: 'date', value: filt.from, style: { width: '160px' } });
  const to = h('input', { type: 'date', value: filt.to, style: { width: '160px' } });
  const q = h('input', { type: 'search', placeholder: 'Устройство, кабинет, сотрудник, основание', value: filt.q });
  const box = h('div');
  const excel = h('a.btn', 'Выгрузить в Excel');
  const load = async () => {
    Object.assign(filt, { from: from.value, to: to.value, q: q.value.trim() });
    const p = new URLSearchParams(filt);
    excel.href = '/inventory/api/moves/export.xlsx?' + p;
    const rows = await api.get('/api/moves?' + p);
    clear(box, h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Дата'), h('th', 'Техника'), h('th', 'Что изменилось'), h('th', 'Основание'), h('th', 'Кто'))),
      h('tbody', rows.length ? rows.map((r) => h('tr',
        h('td.nowrap', h('b', fmtDay(r.moved_on))),
        h('td', typeDot(r), ' ', h('a', { href: `#/devices/${r.device_id}` }, `${r.type_code}-${r.device_id}`), ' ', r.hostname || r.model || '',
          r.inv_number ? h('div.small.muted', `инв. ${r.inv_number}`) : null),
        h('td.mv-chg', Object.entries(r.changes || {}).map(([k, [a, b]]) => h('div', h('span.muted', k + ': '),
          a ? h('span.old', a) : null, a ? ' → ' : '', h('b', b || '—')))),
        h('td.small', r.note || ''),
        h('td.small.muted', r.user_name || '', h('div', fmtDate(r.created_at))))) : h('tr.empty', h('td', { colspan: 5 }, 'Перемещений за этот период нет'))))),
      h('p.muted.small', `Записей: ${rows.length}`));
  };
  [from, to].forEach((x) => x.addEventListener('change', () => run(load)));
  q.addEventListener('input', debounce(() => run(load), 300));
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('span', 'Перемещения')),
    h('div.page-head', h('h1', 'Перемещения техники'), h('span.spacer'), excel),
    h('p.muted', { style: { marginTop: '-8px' } }, 'Кто, куда и когда переместил технику. Переместить — кнопка «Переместить» в карточке техники ',
      'или в списке техники для отмеченных устройств.'),
    h('div.toolbar.row', { style: { gap: '8px', alignItems: 'center', flexWrap: 'nowrap' } }, h('span.muted', 'Период:'), from, h('span.muted', '—'), to, h('div.search-box', { style: { width: '340px' } }, q)),
    box);
  await load();
}

export { isStaff };
