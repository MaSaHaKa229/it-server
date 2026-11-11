// Рабочие места: список, карточка рабочего места, привязка техники
import { h, clear, icon, api, toast, run, modal, confirmDialog, combobox, typeDot, lozenge, deviceKey, debounce, fmtDate } from '../ui.js';
import { isStaff, lookupItems, createLookup } from '../store.js';
import { navigate } from '../app.js';
import { plural } from './devices.js';

const devWord = (n) => `${n} ${plural(n, 'единица', 'единицы', 'единиц')} техники`;

// ---------------- Список ----------------
const sort = { key: 'name', dir: 1 };
const COLS = [
  { key: 'name', label: 'Рабочее место' },
  { key: 'employee', label: 'Сотрудник' },
  { key: 'department', label: 'Отдел' },
  { key: 'location', label: 'Расположение' },
  { key: 'device_count', label: 'Техника' },
];

export async function renderWorkplaces(root) {
  document.title = 'Рабочие места — ИТ Инвентарь';
  const list = await api.get('/api/workplaces');
  const reload = () => renderWorkplaces(root);
  const table = h('table.list');
  const search = h('input', { type: 'search', placeholder: 'Поиск: название, сотрудник, отдел, кабинет' });

  function fill() {
    const q = search.value.trim().toLowerCase();
    const rows = list
      .filter((w) => !q || [w.name, w.employee, w.department, w.location, w.notes].some((v) => (v || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = a[sort.key], y = b[sort.key];
        if (x == null || x === '' || y == null || y === '') return (x == null || x === '') === (y == null || y === '') ? 0 : (x == null || x === '') ? 1 : -1;
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ru', { numeric: true })) * sort.dir;
      });
    clear(table,
      h('thead', h('tr', COLS.map((c) => h('th.sortable', {
        onclick: () => { sort.dir = sort.key === c.key ? -sort.dir : 1; sort.key = c.key; fill(); },
      }, c.label, sort.key === c.key ? h('span.arrow', sort.dir > 0 ? '↑' : '↓') : null)))),
      h('tbody', rows.length ? rows.map((w) => h('tr.clickable', { onclick: () => navigate('/workplaces/' + w.id) },
        h('td', h('a.key-link', { href: '#/workplaces/' + w.id }, w.name)),
        h('td', w.employee || h('span.muted', '—')),
        h('td', w.department || h('span.muted', '—')),
        h('td', w.location || h('span.muted', '—')),
        h('td', w.device_count
          ? [h('span.badge', String(w.device_count)), h('span.muted.small', { style: { marginLeft: '8px' } }, w.device_types || '')]
          : h('span.muted', 'нет техники'))))
        : h('tr.empty', h('td', { colspan: COLS.length }, list.length ? 'Ничего не найдено' : 'Рабочих мест пока нет'))));
  }
  search.addEventListener('input', fill);

  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('span', 'Рабочие места')),
    h('div.page-head', h('h1', 'Рабочие места'), h('span.badge', list.length), h('span.spacer'),
      h('a.btn', { href: '/inventory/api/workplaces/export.xlsx', title: 'Выгрузить список рабочих мест в Excel' }, 'Excel'),
      isStaff() ? h('button.btn.primary', { onclick: () => workplaceModal(null, (id) => navigate('/workplaces/' + id)) }, icon('plus'), 'Создать рабочее место') : null),
    h('p.muted', { style: { margin: '-8px 0 16px' } },
      'Рабочее место объединяет технику одного сотрудника или точки: компьютер, монитор, принтер, телефон и т.д.'),
    h('div.toolbar', h('div.search-box', icon('search'), search)),
    h('div.table-wrap', table));
  fill();
  void reload;
}

// ---------------- Создание / изменение ----------------
function workplaceModal(w, done) {
  const name = h('input', { type: 'text', value: w?.name || '', placeholder: 'Например: Бухгалтерия, место 3' });
  const lk = (kind, idKey, labelKey) => combobox({
    value: w && w[idKey] ? { id: w[idKey], label: w[labelKey] } : null,
    placeholder: 'Выберите или введите новое…',
    load: () => lookupItems(kind),
    create: (text) => createLookup(kind, text),
  });
  const employee = lk('employee', 'employee_id', 'employee');
  const department = lk('department', 'department_id', 'department');
  const location = lk('location', 'location_id', 'location');
  const notes = h('textarea', { rows: 3 });
  notes.value = w?.notes || '';
  const idOf = (cb) => (cb.get() ? cb.get().id : null);
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { name: name.value, employee_id: idOf(employee), department_id: idOf(department), location_id: idOf(location), notes: notes.value };
      let id = w?.id;
      if (w) await api.put('/api/workplaces/' + w.id, body); else id = (await api.post('/api/workplaces', body)).id;
      m.close(); toast(w ? 'Изменения сохранены' : 'Рабочее место создано'); done(id);
    }, save),
  }, w ? 'Сохранить' : 'Создать');
  const m = modal({
    title: w ? 'Рабочее место' : 'Новое рабочее место',
    body: h('div.stack', { style: { gap: '16px' } },
      h('label.field', h('span', 'Название'), name),
      h('div.form-grid',
        h('div.field', h('span.field-label', 'Сотрудник'), employee.el),
        h('div.field', h('span.field-label', 'Отдел'), department.el),
        h('div.field.wide', h('span.field-label', 'Расположение'), location.el)),
      h('label.field', h('span', 'Примечание'), notes)),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  setTimeout(() => name.focus(), 40);
}

// ---------------- Карточка рабочего места ----------------
export async function renderWorkplace(root, id) {
  const w = await api.get('/api/workplaces/' + id);
  document.title = `${w.name} — Рабочие места`;
  const staff = isStaff();
  const reload = () => renderWorkplace(root, id);

  const detach = (d) => run(async () => {
    await api.del(`/api/workplaces/${id}/devices/${d.id}`);
    toast(`${deviceKey(d)} отвязано от рабочего места`);
    reload();
  });

  const row = (label, value) => h('div.drow', h('div.dl', label), h('div.dv', h('div.editable.readonly', value || h('span.ph', '—'))));

  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'),
      h('a', { href: '#/workplaces' }, 'Рабочие места'), h('span.sep', '/'), h('span', w.name)),
    h('div.issue.wp-issue',
      h('div',
        h('div.row', { style: { alignItems: 'flex-start' } }, h('h1.issue-title.grow', w.name), (() => {
          const span = h('span');
          import('/shared/recent.js').then((m) => span.append(m.starButton({ kind: 'workplace', ref: String(w.id), title: w.name, link: `/inventory/#/workplaces/${w.id}` }))).catch(() => {});
          return span;
        })()),
        staff ? h('div.issue-actions',
          h('button.btn.primary', { onclick: () => attachModal(w, reload) }, icon('plus'), 'Привязать технику'),
          h('button.btn', { onclick: () => workplaceModal(w, reload) }, icon('edit'), 'Изменить'),
          h('button.btn', {
            onclick: async () => {
              if (!await confirmDialog({
                title: `Удалить рабочее место «${w.name}»?`,
                text: w.devices.length ? `Техника (${w.devices.length}) останется в базе, но будет отвязана от рабочего места.` : 'Рабочее место будет удалено.',
              })) return;
              run(async () => { await api.del('/api/workplaces/' + id); toast('Рабочее место удалено'); navigate('/workplaces'); });
            },
          }, icon('trash'), 'Удалить')) : null,
        h('div.section',
          h('h3', 'Техника на рабочем месте ', h('span.badge', w.devices.length)),
          w.devices.length
            ? h('div.table-wrap', h('table.list',
              h('thead', h('tr', h('th', 'Ключ'), h('th', 'Сетевое имя'), h('th', 'Модель'), h('th', 'Инв. №'),
                h('th', 'Состояние'), staff ? h('th', '') : null)),
              h('tbody', w.devices.map((d) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button')) navigate('/devices/' + d.id); } },
                h('td', h('span.type-cell', typeDot(d), h('a.key-link', { href: '#/devices/' + d.id }, deviceKey(d)))),
                h('td', d.hostname || h('span.muted', '—')),
                h('td', d.model || h('span.muted', '—')),
                h('td', d.inv_number || h('span.muted', '—')),
                h('td', lozenge(d.status)),
                staff ? h('td.nowrap', { style: { textAlign: 'right' } },
                  h('button.btn.subtle.sm.icon', { title: 'Отвязать от рабочего места', onclick: () => detach(d) }, icon('close', 14))) : null)))))
            : h('div.empty-state', h('h3', 'Техника не привязана'),
              staff ? h('p', 'Нажмите «Привязать технику» и выберите из базы компьютер, монитор, принтер и другое оборудование этого места.') : null)),
        w.notes ? h('div.section', h('h3', 'Примечание'), h('div.pre', w.notes)) : null),
      h('div',
        h('div.details',
          h('div.d-head', 'Сведения'),
          h('div.d-body',
            row('Сотрудник', w.employee),
            row('Отдел', w.department),
            row('Расположение', w.location),
            row('Техника', w.device_count ? `${devWord(w.device_count)}: ${w.device_types}` : null))),
        h('div.dates',
          h('div', 'Создано ', fmtDate(w.created_at)),
          h('div', 'Изменено ', fmtDate(w.updated_at))))));
}

// ---------------- Привязка техники ----------------
function attachModal(w, done) {
  const selected = new Map(); // id -> устройство
  const q = h('input', { type: 'search', placeholder: 'Поиск по базе: имя, инв. №, модель, сотрудник, кабинет…' });
  const list = h('div', { style: { maxHeight: '46vh', overflowY: 'auto', marginTop: '12px', borderTop: '2px solid var(--border)' } });
  const chosen = h('div.small.muted', { style: { marginTop: '8px' } });
  const save = h('button.btn.primary', {
    disabled: true,
    onclick: () => run(async () => {
      const r = await api.post(`/api/workplaces/${w.id}/devices`, { ids: [...selected.keys()] });
      m.close(); toast(`Привязано: ${r.attached}`); done();
    }, save),
  }, 'Привязать');

  function updateChosen() {
    save.disabled = !selected.size;
    save.textContent = selected.size ? `Привязать (${selected.size})` : 'Привязать';
    chosen.textContent = selected.size ? 'Выбрано: ' + [...selected.values()].map((d) => deviceKey(d)).join(', ') : 'Отметьте технику галочками — можно выбрать сколько угодно и искать несколько раз.';
  }

  const load = debounce(async () => {
    let rows = [];
    try { rows = await api.get(`/api/workplaces/${w.id}/candidates?q=` + encodeURIComponent(q.value.trim())); } catch { /* покажем пусто */ }
    clear(list, rows.length ? h('table.list', h('tbody', rows.map((d) => {
      const here = d.workplace_id === w.id;
      const cb = h('input', { type: 'checkbox', checked: here || selected.has(d.id), disabled: here });
      const toggle = () => {
        if (here) return;
        if (selected.has(d.id)) selected.delete(d.id); else selected.set(d.id, d);
        cb.checked = selected.has(d.id); updateChosen();
      };
      return h('tr' + (here ? '' : '.clickable'), { onclick: (e) => { if (e.target !== cb) toggle(); } },
        h('td.check-col', cb),
        h('td', h('span.type-cell', typeDot(d), h('span.key-link', deviceKey(d)))),
        h('td', d.hostname || d.model || h('span.muted', d.type_name)),
        h('td.muted', [d.model, d.inv_number].filter(Boolean).join(' · ')),
        h('td.small', here ? h('span.lozenge.green', 'уже здесь')
          : d.workplace ? h('span.lozenge.yellow', { title: 'При привязке техника будет перенесена сюда' }, 'сейчас: ' + d.workplace)
            : h('span.muted', 'свободно')));
    }))) : h('p.muted', { style: { padding: '16px 8px' } }, 'Ничего не найдено'));
    list.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', (e) => {
      e.target.checked = !e.target.checked; e.target.closest('tr').click();
    }));
  }, 250);
  q.addEventListener('input', load);

  const m = modal({
    title: `Привязать технику: ${w.name}`, size: 'wide',
    body: h('div', h('div.search-box', { style: { width: '100%' } }, icon('search'), q), list, chosen),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  updateChosen();
  load();
}
