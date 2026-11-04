// Модальное окно «Создать устройство» (аналог «Создать задачу» в Jira)
import { h, clear, api, modal, toast, run, lozenge } from '../ui.js';
import { state, typeById, coreFieldsForType, customFieldsForType, fieldEditor } from '../store.js';
import { navigate } from '../app.js';

export function openCreateDevice(presetTypeId) {
  const types = state.meta.types;
  if (!types.length) { toast('Сначала создайте тип техники в настройках', 'info'); return; }
  let typeId = Number(presetTypeId) || Number(localStorage.getItem('itdb.lastType')) || types[0].id;
  if (!typeById(typeId)) typeId = types[0].id;

  const typeSel = h('select', types.map((t) => h('option', { value: t.id, selected: t.id === typeId }, t.name)));
  // Первое состояние в списке — значение по умолчанию
  const statusSel = h('select', state.meta.statuses.map((s) => h('option', { value: s.key }, s.label)));
  const statusPreview = h('span');
  const updStatus = () => clear(statusPreview, lozenge(statusSel.value));
  statusSel.addEventListener('change', updStatus); updStatus();

  const fieldsBox = h('div.form-grid');
  let editors = [];
  const values = {}; // сохраняем введённое при смене типа

  function collect() {
    for (const ed of editors) {
      const p = ed.patch();
      if (p.extra) values.extra = { ...(values.extra || {}), ...p.extra }; else Object.assign(values, p);
    }
  }
  function build() {
    collect();
    // Превращаем сохранённые значения обратно в "устройство" для редакторов
    const dev = { extra: {} };
    for (const [k, v] of Object.entries(values)) {
      if (k === 'extra') Object.assign(dev.extra, v); else dev[k] = v;
    }
    editors = [];
    clear(fieldsBox);
    const core = coreFieldsForType(typeId, { withText: true });
    for (const f of core) {
      // Для справочников нужно имя выбранного значения — храним его в _labels
      if (f.kind === 'lookup' && dev[f.col]) dev[f.key] = labels[f.col];
      const ed = fieldEditor(f, dev);
      trackLabel(f, ed);
      editors.push(ed);
      fieldsBox.append(h('label.field' + (f.kind === 'textarea' ? '.wide' : ''), h('span', f.label), ed.el));
    }
    const custom = customFieldsForType(typeId);
    if (custom.length) {
      fieldsBox.append(h('div.wide', h('h4', { style: { marginTop: '8px' } }, 'Дополнительные поля')));
      for (const f of custom) {
        const ed = fieldEditor(f, dev);
        editors.push(ed);
        fieldsBox.append(h('label.field' + (f.kind === 'textarea' ? '.wide' : ''), h('span', f.label), ed.el));
      }
    }
  }
  const labels = {};
  function trackLabel(f, ed) {
    if (f.kind !== 'lookup') return;
    const input = ed.el.querySelector('input');
    const orig = ed.patch;
    ed.patch = () => { const p = orig(); labels[f.col] = input.value; return p; };
  }

  typeSel.addEventListener('change', () => { typeId = Number(typeSel.value); build(); });
  build();

  const more = h('input', { type: 'checkbox' });
  const createBtn = h('button.btn.primary', { onclick: submit }, 'Создать');

  async function submit() {
    await run(async () => {
      const body = { type_id: typeId, status: statusSel.value, extra: {} };
      for (const ed of editors) {
        const p = ed.patch();
        if (p.extra) Object.assign(body.extra, p.extra); else Object.assign(body, p);
      }
      const { id } = await api.post('/api/devices', body);
      localStorage.setItem('itdb.lastType', typeId);
      const t = typeById(typeId);
      toast(h('span', 'Создано устройство ', h('a', { href: `#/devices/${id}` }, `${t.code}-${id}`)), 'ok', 'Готово');
      window.dispatchEvent(new Event('itdb:changed'));
      if (more.checked) {
        // Оставляем тип и справочные значения, чистим уникальные поля
        for (const k of ['inv_number', 'hostname', 'serial_number', 'ip_address', 'mac_address']) values[k] = '';
        editors = editors.filter(() => false);
        build();
      } else {
        m.close();
        navigate('/devices/' + id);
      }
    }, createBtn);
  }

  const m = modal({
    title: 'Создать устройство', size: 'wide',
    body: h('div.stack', { style: { gap: '16px' } },
      h('div.form-grid',
        h('label.field', h('span', 'Тип техники ', h('span.req', '*')), typeSel),
        h('label.field', h('span', 'Состояние'), h('div.row', statusSel, statusPreview))),
      h('div', { style: { borderTop: '1px solid var(--n30)' } }),
      fieldsBox,
      h('p.hint', 'Модель, пользователь, отдел и другие характеристики выбираются из справочников. ',
        'Если нужного значения нет — начните вводить его и нажмите «Добавить».')),
    footer: [
      h('label.check', { style: { marginRight: 'auto' } }, more, 'Создать ещё одно'),
      h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'),
      createBtn,
    ],
  });
  statusPreview.style.flex = 'none';
}
