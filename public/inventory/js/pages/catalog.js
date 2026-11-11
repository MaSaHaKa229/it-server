// Справочники: модели, сотрудники, отделы, характеристики, ПО и пользовательские справочники
import { h, clear, icon, api, toast, run, modal, confirmDialog, combobox } from '../ui.js';
import { state, loadMeta, invalidateLookups, invalidateSoftware, softwareFields, fieldEditor, displayValue } from '../store.js';
import { navigate } from '../app.js';

export async function renderCatalog(root, kind) {
  document.title = 'Справочники — ИТ Инвентарь';
  await loadMeta();
  const kinds = state.meta.lookupKinds;
  if (!kind) kind = kinds[0]?.code || 'software';
  const body = h('div');
  const nav = h('div.vnav',
    kinds.map((k) => h('a.side-link' + (k.code === kind ? '.active' : ''), { href: '#/catalog/' + k.code }, k.name)),
    h('a.side-link' + (kind === 'software' ? '.active' : ''), { href: '#/catalog/software' }, 'Программы (ПО)'),
    h('div.menu-sep'),
    h('a.side-link', { href: '#', onclick: (e) => { e.preventDefault(); newKind(); } }, icon('plus'), 'Новый справочник'));
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('span', 'Справочники')),
    h('div.page-head', h('h1', 'Справочники')),
    h('div.split', nav, body));
  if (kind === 'software') await renderSoftware(body);
  else await renderKind(body, kinds.find((k) => k.code === kind) || kinds[0]);
}

function newKind() {
  const name = h('input', { type: 'text', placeholder: 'Например: Поставщики, Мониторы, Корпуса' });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const r = await api.post('/api/lookup-kinds', { name: name.value });
      m.close(); toast('Справочник создан. Используйте его в доп. поле с форматом «Справочник».');
      await loadMeta(); navigate('/catalog/' + r.code);
    }, save),
  }, 'Создать');
  const m = modal({
    title: 'Новый справочник', size: 'narrow',
    body: h('div.stack', h('label.field', h('span', 'Название'), name),
      h('p.hint', 'Свой справочник можно подключить к дополнительному полю — тогда при заполнении значение выбирается из списка.')),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

const fieldKeyForKind = (code) => state.meta.coreFields.find((f) => f.lookup === code)?.key;
// Справочники с полным и коротким названием (сейчас — «Отделы»; их видят сотрудники при регистрации на сайте заявок)
const NAMED_KINDS = ['department'];

async function renderKind(box, kind) {
  const rows = await api.get(`/api/lookups?kind=${encodeURIComponent(kind.code)}&usage=1&limit=5000`);
  const fkey = fieldKeyForKind(kind.code);
  const search = h('input', { type: 'search', placeholder: 'Поиск…' });
  const tbody = h('tbody');
  const addVal = h('input', { type: 'text', placeholder: 'Новое значение' });
  const addNote = h('input', { type: 'text', placeholder: 'Примечание (необязательно)' });
  const named = NAMED_KINDS.includes(kind.code);
  const addFull = h('input', { type: 'text', placeholder: 'Полное название (необязательно)' });
  const addShort = h('input', { type: 'text', placeholder: 'Короткое' });
  const addBtn = h('button.btn.primary', { onclick: add }, 'Добавить');
  addVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  async function add() {
    await run(async () => {
      if (!addVal.value.trim()) throw new Error('Введите значение');
      await api.post('/api/lookups', { kind: kind.code, value: addVal.value, note: addNote.value,
        ...(named ? { full_name: addFull.value, short_name: addShort.value } : {}) });
      invalidateLookups(kind.code);
      toast('Добавлено');
      renderKind(box, kind);
    }, addBtn);
  }

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const list = rows.filter((r) => !q || [r.value, r.note, r.full_name, r.short_name].some((x) => (x || '').toLowerCase().includes(q)));
    clear(tbody, list.length ? list.map((r) => h('tr',
      h('td', h('strong', r.value)),
      named ? h('td', r.full_name || h('span.muted', '—')) : null,
      named ? h('td', r.short_name || h('span.muted', '—')) : null,
      h('td.muted', r.note || ''),
      h('td', r.usage && fkey
        ? h('a', { href: `#/devices?f=${encodeURIComponent(JSON.stringify({ [fkey]: [r.id] }))}` }, r.usage)
        : h('span.muted', r.usage || 0)),
      h('td.nowrap', { style: { textAlign: 'right' } },
        h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => editValue(kind, r, () => renderKind(box, kind)) }, icon('edit', 14)),
        h('button.btn.subtle.sm', { title: 'Объединить с другим значением', onclick: () => mergeValue(kind, r, () => renderKind(box, kind)) }, 'Объединить'),
        h('button.btn.subtle.sm.icon', {
          title: 'Удалить',
          onclick: async () => {
            if (!await confirmDialog({
              title: `Удалить «${r.value}»?`,
              text: r.usage ? `Значение используется у ${r.usage} устр. — у них это поле станет пустым.` : 'Значение будет удалено из справочника.',
            })) return;
            run(async () => { await api.del('/api/lookups/' + r.id); invalidateLookups(kind.code); toast('Удалено'); renderKind(box, kind); });
          },
        }, icon('trash', 14)))))
      : h('tr.empty', h('td', { colspan: named ? 6 : 4 }, q ? 'Ничего не найдено' : 'Справочник пуст')));
  };
  search.addEventListener('input', draw);

  clear(box,
    h('div.page-head', h('h2', kind.name), h('span.badge', rows.length), h('span.spacer'),
      !kind.is_system ? h('button.btn.subtle', { onclick: () => renameKind(kind) }, icon('edit'), 'Переименовать') : null,
      !kind.is_system ? h('button.btn.subtle', {
        onclick: async () => {
          if (!await confirmDialog({ title: `Удалить справочник «${kind.name}»?`, text: 'Все его значения будут удалены.' })) return;
          run(async () => { await api.del('/api/lookup-kinds/' + kind.code); invalidateLookups(); await loadMeta(); navigate('/catalog'); });
        },
      }, icon('trash'), 'Удалить') : null),
    h('div.toolbar',
      h('div', { style: { flex: '2', minWidth: '200px' } }, addVal),
      named ? h('div', { style: { flex: '3', minWidth: '220px' } }, addFull) : null,
      named ? h('div', { style: { flex: '1', minWidth: '120px' } }, addShort) : null,
      h('div', { style: { flex: '2', minWidth: '200px' } }, addNote),
      addBtn),
    named ? h('p.hint', { style: { margin: '-4px 0 12px' } },
      'Отделы видят сотрудники при регистрации на сайте заявок и ищут свой по значению, полному или короткому названию.') : null,
    h('div.toolbar', h('div.search-box', icon('search'), search)),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Значение'), named ? h('th', 'Полное название') : null, named ? h('th', 'Короткое') : null,
        h('th', 'Примечание'), h('th', 'Устройств'), h('th', ''))),
      tbody)));
  draw();
}

function editValue(kind, r, done) {
  const named = NAMED_KINDS.includes(kind.code);
  const value = h('input', { type: 'text', value: r.value });
  const note = h('input', { type: 'text', value: r.note || '' });
  const full = h('input', { type: 'text', value: r.full_name || '', placeholder: 'Например: Отдел бухгалтерского учёта и отчётности' });
  const short = h('input', { type: 'text', value: r.short_name || '', placeholder: 'Например: ОБУиО' });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      await api.put('/api/lookups/' + r.id, { value: value.value, note: note.value,
        ...(named ? { full_name: full.value, short_name: short.value } : {}) });
      invalidateLookups(kind.code); m.close(); toast('Сохранено'); done();
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: 'Изменить значение', size: 'narrow',
    body: h('div.stack', { style: { gap: '12px' } }, h('label.field', h('span', 'Значение'), value),
      named ? h('label.field', h('span', 'Полное название'), full) : null,
      named ? h('label.field', h('span', 'Короткое название'), short) : null,
      h('label.field', h('span', 'Примечание'), note),
      h('p.hint', 'Изменение сразу отразится во всех устройствах, где используется это значение.')),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

function mergeValue(kind, r, done) {
  const cb = combobox({
    placeholder: 'Выберите значение…',
    load: async () => (await api.get('/api/lookups?kind=' + encodeURIComponent(kind.code)))
      .filter((x) => x.id !== r.id).map((x) => ({ id: x.id, label: x.value })),
  });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      if (!cb.get()) throw new Error('Выберите значение');
      await api.post(`/api/lookups/${r.id}/merge`, { into: cb.get().id });
      invalidateLookups(kind.code); m.close(); toast('Значения объединены'); done();
    }, save),
  }, 'Объединить');
  const m = modal({
    title: `Объединить «${r.value}»`, size: 'narrow',
    body: h('div.stack', h('p', 'Все устройства, где указано «', h('strong', r.value), '», получат выбранное значение, а «', r.value, '» будет удалено. Удобно для исправления дублей.'),
      h('div.field', h('span.field-label', 'Заменить на'), cb.el)),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

function renameKind(kind) {
  const name = h('input', { type: 'text', value: kind.name });
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      await api.put('/api/lookup-kinds/' + kind.code, { name: name.value });
      m.close(); await loadMeta(); navigate('/catalog/' + kind.code);
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: 'Переименовать справочник', size: 'narrow',
    body: h('label.field', h('span', 'Название'), name),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ---------- Программы ----------
async function renderSoftware(box) {
  const rows = await api.get('/api/software');
  const swF = softwareFields('software');
  const again = () => renderSoftware(box);
  const search = h('input', { type: 'search', placeholder: 'Поиск…' });
  const tbody = h('tbody');
  const name = h('input', { type: 'text', placeholder: 'Название программы' });
  const vendor = h('input', { type: 'text', placeholder: 'Производитель' });
  const addBtn = h('button.btn.primary', {
    onclick: () => {
      // Есть доп. поля — открываем окно, чтобы заполнить их сразу
      if (swF.length) { programModal(null, again, { name: name.value, vendor: vendor.value }); return; }
      run(async () => {
        await api.post('/api/software', { name: name.value, vendor: vendor.value });
        invalidateSoftware(); toast('Программа добавлена'); again();
      }, addBtn);
    },
  }, 'Добавить');
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

  const fieldText = (r, f) => displayValue(f, { extra: r.extra || {} });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const list = rows.filter((r) => !q || [r.name, r.vendor, ...swF.map((f) => fieldText(r, f))]
      .some((v) => String(v || '').toLowerCase().includes(q)));
    clear(tbody, list.length ? list.map((r) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('a, button')) programModal(r, again); } },
      h('td', h('strong', r.name)),
      h('td.muted', r.vendor || ''),
      swF.map((f) => { const v = fieldText(r, f); return h('td', { title: String(v) }, v); }),
      h('td', r.usage ? h('a', { href: `#/devices?f=${encodeURIComponent(JSON.stringify({ software: [r.id] }))}`, title: 'Показать устройства' }, r.usage) : h('span.muted', 0)),
      h('td.nowrap', { style: { textAlign: 'right' } },
        h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => programModal(r, again) }, icon('edit', 14)),
        h('button.btn.subtle.sm.icon', {
          title: 'Удалить',
          onclick: async () => {
            if (!await confirmDialog({ title: `Удалить «${r.name}»?`, text: r.usage ? `Программа будет удалена со всех устройств (${r.usage}).` : 'Программа будет удалена из справочника.' })) return;
            run(async () => { await api.del('/api/software/' + r.id); invalidateSoftware(); toast('Удалено'); again(); });
          },
        }, icon('trash', 14)))))
      : h('tr.empty', h('td', { colspan: 4 + swF.length }, q ? 'Ничего не найдено' : 'Справочник ПО пуст')));
  };
  search.addEventListener('input', draw);
  clear(box,
    h('div.page-head', h('h2', 'Программы (ПО)'), h('span.badge', rows.length), h('span.spacer'),
      h('a.btn.subtle', { href: '#/settings/fields' }, icon('cog'), 'Поля ПО')),
    h('div.toolbar', h('div', { style: { flex: '2', minWidth: '200px' } }, name), h('div', { style: { flex: '1', minWidth: '160px' } }, vendor), addBtn),
    h('div.toolbar', h('div.search-box', icon('search'), search)),
    h('div.table-wrap', h('table.list', h('thead', h('tr', h('th', 'Программа'), h('th', 'Производитель'),
      swF.map((f) => h('th', f.label)), h('th', 'Устройств'), h('th', ''))), tbody)));
  draw();
}

/** Создание / изменение программы со всеми её полями */
function programModal(r, done, preset = {}) {
  const swF = softwareFields('software');
  const name = h('input', { type: 'text', value: r?.name ?? preset.name ?? '' });
  const vendor = h('input', { type: 'text', value: r?.vendor ?? preset.vendor ?? '' });
  const dev = { extra: { ...(r?.extra || {}) } };
  const editors = swF.map((f) => ({ f, ed: fieldEditor(f, dev) }));
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const extra = Object.assign({}, ...editors.map(({ ed }) => ed.patch().extra));
      const body = { name: name.value, vendor: vendor.value, extra };
      if (r) await api.put('/api/software/' + r.id, body); else await api.post('/api/software', body);
      invalidateSoftware(); m.close(); toast(r ? 'Сохранено' : 'Программа добавлена'); done();
    }, save),
  }, r ? 'Сохранить' : 'Добавить');
  const m = modal({
    title: r ? 'Изменить программу' : 'Новая программа', size: swF.length ? '' : 'narrow',
    body: h('div.form-grid',
      h('label.field' + (swF.length ? '' : '.wide'), h('span', 'Название'), name),
      h('label.field' + (swF.length ? '' : '.wide'), h('span', 'Производитель'), vendor),
      editors.map(({ f, ed }) => h('label.field' + (f.kind === 'textarea' ? '.wide' : ''), h('span', f.label), ed.el)),
      r?.usage ? h('p.hint.wide', `Изменения будут видны на всех устройствах, где установлена программа (${r.usage}).`) : null),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}
