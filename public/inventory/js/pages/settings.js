// Настройки: типы техники, состояния и дополнительные поля
import { h, clear, icon, api, toast, run, modal, confirmDialog, typeDot, lozenge, setStatuses } from '../ui.js';
import { state, loadMeta, FIELD_TYPE_LABELS, isSuper } from '../store.js';
import { renderNetprobeSettings } from './netprobe-settings.js';

const COLORS = ['#0052CC', '#00A3BF', '#6554C0', '#FF8B00', '#36B37E', '#DE350B', '#FFAB00', '#8993A4', '#172B4D', '#00875A'];

export async function renderSettings(root, tab = 'types') {
  document.title = 'Настройки — ИТ Инвентарь';
  const body = h('div');
  const nav = h('div.vnav',
    h('a.side-link' + (tab === 'types' ? '.active' : ''), { href: '#/settings/types' }, 'Типы техники'),
    h('a.side-link' + (tab === 'statuses' ? '.active' : ''), { href: '#/settings/statuses' }, 'Состояния'),
    h('a.side-link' + (tab === 'fields' ? '.active' : ''), { href: '#/settings/fields' }, 'Дополнительные поля'),
    isSuper() ? h('a.side-link' + (tab === 'netprobe' ? '.active' : ''), { href: '#/settings/netprobe' }, 'Сведения из сети') : null);
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('span', 'Настройки')),
    h('div.page-head', h('h1', 'Настройки')),
    h('div.split', nav, body));
  if (tab === 'netprobe' && isSuper()) await renderNetprobeSettings(body);
  else if (tab === 'fields') await renderFields(body);
  else if (tab === 'statuses') await renderStatuses(body);
  else await renderTypes(body);
}

// ================= Состояния техники =================
const STATUS_COLORS = ['#36B37E', '#00875A', '#0052CC', '#00A3BF', '#6554C0', '#FFAB00', '#FF8B00', '#DE350B', '#8993A4', '#172B4D'];

async function statusesChanged() {
  await loadMeta(); // обновляет и цвета/названия лозенджей
  window.dispatchEvent(new Event('itdb:changed'));
}

async function renderStatuses(box) {
  const list = await api.get('/api/statuses');
  setStatuses(list);
  const reload = () => renderStatuses(box);

  const move = (i, d) => run(async () => {
    const keys = list.map((s) => s.key);
    [keys[i], keys[i + d]] = [keys[i + d], keys[i]];
    await api.post('/api/statuses/reorder', { keys });
    await statusesChanged(); reload();
  });

  clear(box,
    h('div.page-head', h('h2', 'Состояния техники'), h('span.spacer'),
      h('button.btn.primary', { onclick: () => statusModal(null, reload) }, icon('plus'), 'Новое состояние')),
    h('p.muted', { style: { marginTop: '-8px', marginBottom: '16px' } },
      'Например: «На складе», «В ремонте», «Резерв», «Выдано во временное пользование». ',
      'Первое состояние в списке подставляется по умолчанию при добавлении техники. Порядок меняется стрелками.'),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', ''), h('th', 'Состояние'), h('th', 'Устройств'), h('th', ''))),
      h('tbody', list.map((s, i) => h('tr',
        h('td.nowrap', { style: { width: '64px' } },
          h('button.btn.subtle.sm.icon', { title: 'Выше', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button.btn.subtle.sm.icon', { title: 'Ниже', disabled: i === list.length - 1, onclick: () => move(i, 1) }, '↓')),
        h('td', lozenge(s.key), i === 0 ? h('span.muted.small', { style: { marginLeft: '8px' } }, 'по умолчанию') : null),
        h('td', s.usage
          ? h('a', { href: `#/devices?f=${encodeURIComponent(JSON.stringify({ status: [s.key] }))}` }, s.usage)
          : h('span.muted', '0')),
        h('td.nowrap', { style: { textAlign: 'right' } },
          h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => statusModal(s, reload) }, icon('edit', 14)),
          h('button.btn.subtle.sm.icon', {
            title: 'Удалить', disabled: list.length < 2,
            onclick: () => deleteStatus(s, list, reload),
          }, icon('trash', 14)))))))));
}

function statusModal(s, done) {
  const label = h('input', { type: 'text', value: s?.label || '', maxlength: 50, placeholder: 'Например: В ремонте' });
  let color = s?.color || STATUS_COLORS[2];
  const preview = h('span');
  const sw = h('div.color-swatches');
  const draw = () => {
    clear(sw, STATUS_COLORS.map((c) => h('button' + (c === color ? '.on' : ''), {
      type: 'button', title: c, style: { background: c }, onclick: () => { color = c; draw(); },
    })));
    setStatuses([{ key: '__preview', label: label.value.trim() || 'Пример', color }]);
    clear(preview, lozenge('__preview'));
    setStatuses(state.meta.statuses);
  };
  label.addEventListener('input', draw);
  draw();
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { label: label.value, color };
      if (s) await api.put('/api/statuses/' + encodeURIComponent(s.key), body);
      else await api.post('/api/statuses', body);
      m.close(); toast(s ? 'Состояние изменено' : 'Состояние добавлено');
      await statusesChanged(); done();
    }, save),
  }, s ? 'Сохранить' : 'Добавить');
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  const m = modal({
    title: s ? 'Изменить состояние' : 'Новое состояние', size: 'narrow',
    body: h('div.stack', { style: { gap: '14px' } },
      h('label.field', h('span', 'Название'), label),
      h('div.field', h('span.field-label', 'Цвет'), sw),
      h('div.field', h('span.field-label', 'Как будет выглядеть'), preview),
      s ? h('p.hint', 'Новое название сразу появится у всей техники с этим состоянием.') : null),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

async function deleteStatus(s, list, done) {
  if (!s.usage) {
    if (!await confirmDialog({ title: `Удалить состояние «${s.label}»?`, text: 'Техники с этим состоянием нет, удаление ничего не затронет.' })) return;
    return run(async () => {
      await api.del('/api/statuses/' + encodeURIComponent(s.key));
      toast('Состояние удалено'); await statusesChanged(); done();
    });
  }
  // Состояние используется — нужно выбрать, куда перевести технику
  const others = list.filter((x) => x.key !== s.key);
  const target = h('select', others.map((x) => h('option', { value: x.key }, x.label)));
  const del = h('button.btn.danger', {
    onclick: () => run(async () => {
      await api.del(`/api/statuses/${encodeURIComponent(s.key)}?move_to=${encodeURIComponent(target.value)}`);
      m.close(); toast(`Состояние удалено, техника (${s.usage} шт.) переведена в «${others.find((x) => x.key === target.value).label}»`);
      await statusesChanged(); done();
    }, del),
  }, 'Перевести и удалить');
  const m = modal({
    title: `Удалить состояние «${s.label}»?`, size: 'narrow',
    body: h('div.stack', { style: { gap: '12px' } },
      h('p', `Это состояние сейчас у ${s.usage} устр. Выберите, какое состояние им назначить. Изменение запишется в историю каждого устройства.`),
      h('label.field', h('span', 'Перевести в'), target)),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), del],
  });
}

// ================= Типы техники =================
async function renderTypes(box) {
  await loadMeta();
  const types = state.meta.types;
  const core = state.meta.coreFields;
  clear(box,
    h('div.page-head', h('h2', 'Типы техники'), h('span.spacer'),
      h('button.btn.primary', { onclick: () => typeModal(null, core, () => renderTypes(box)) }, icon('plus'), 'Новый тип')),
    h('p.muted', { style: { marginTop: '-8px', marginBottom: '16px' } },
      'Код используется в ключе устройства (например, PC-12). Для каждого типа можно выбрать, какие базовые поля показывать.'),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Тип'), h('th', 'Код'), h('th', 'Поля'), h('th', ''))),
      h('tbody', types.map((t) => h('tr',
        h('td', h('span.type-cell', typeDot(t), h('strong', t.name))),
        h('td.mono', t.code),
        h('td.muted', { style: { whiteSpace: 'normal' } }, core.filter((f) => t.fields.includes(f.key)).map((f) => f.label).join(', ')),
        h('td.nowrap', { style: { textAlign: 'right' } },
          h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => typeModal(t, core, () => renderTypes(box)) }, icon('edit', 14)),
          h('button.btn.subtle.sm.icon', {
            title: 'Удалить',
            onclick: async () => {
              if (!await confirmDialog({ title: `Удалить тип «${t.name}»?`, text: 'Удалить можно только тип, у которого нет устройств.' })) return;
              run(async () => { await api.del('/api/types/' + t.id); toast('Тип удалён'); await loadMeta(); renderTypes(box); window.dispatchEvent(new Event('itdb:changed')); });
            },
          }, icon('trash', 14)))))))));
}

function typeModal(t, core, done) {
  const name = h('input', { type: 'text', value: t?.name || '' });
  const code = h('input', { type: 'text', value: t?.code || '', maxlength: 10, placeholder: 'PC' });
  let color = t?.color || COLORS[0];
  const sw = h('div.color-swatches');
  const drawSw = () => clear(sw, COLORS.map((c) => h('button' + (c === color ? '.on' : ''), { type: 'button', style: { background: c }, onclick: () => { color = c; drawSw(); } })));
  drawSw();
  const fields = new Set(t ? t.fields : core.map((f) => f.key).filter((k) => k !== 'notes'));
  const checks = core.filter((f) => f.key !== 'notes').map((f) => h('label.check', h('input', {
    type: 'checkbox', checked: fields.has(f.key),
    onchange: (e) => (e.target.checked ? fields.add(f.key) : fields.delete(f.key)),
  }), f.label));
  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { name: name.value, code: code.value, color, fields: [...fields], sort: t?.sort ?? 50 };
      if (t) await api.put('/api/types/' + t.id, body); else await api.post('/api/types', body);
      m.close(); toast('Тип сохранён'); await loadMeta(); done(); window.dispatchEvent(new Event('itdb:changed'));
    }, save),
  }, 'Сохранить');
  const m = modal({
    title: t ? 'Изменить тип' : 'Новый тип техники',
    body: h('div.form-grid',
      h('label.field', h('span', 'Название'), name),
      h('label.field', h('span', 'Код (латиница)'), code),
      h('div.field.wide', h('span.field-label', 'Цвет'), sw),
      h('div.field.wide', h('span.field-label', 'Показывать базовые поля'), h('div.perm-list', { style: { maxHeight: 'none' } }, checks))),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

// ================= Дополнительные поля =================
async function renderFields(box) {
  const [defs, swDefs] = await Promise.all([api.get('/api/fields'), api.get('/api/software-fields')]);
  const again = () => renderFields(box);
  const scopeLabel = (d) => d.scope === 'all' ? h('span.lozenge.blue', 'Вся техника')
    : d.scope === 'type' ? h('span.lozenge.purple', 'Тип: ' + (d.type_name || '?'))
    : h('span.lozenge.yellow', 'Экземпляр ', h('a', { href: `#/devices/${d.device_id}` }, d.device_key || '#' + d.device_id));
  const targetLabel = (d) => d.target === 'software'
    ? h('span.lozenge.purple', 'Программа в справочнике')
    : h('span.lozenge.blue', 'Установка на устройстве');
  const formatCell = (d) => h('td', FIELD_TYPE_LABELS[d.field_type],
    d.field_type === 'select' ? h('span.muted.small', ` (${d.options.join(', ')})`) : null,
    d.field_type === 'lookup' ? h('span.muted.small', ` (${state.meta.lookupKinds.find((k) => k.code === d.lookup_kind)?.name || '—'})`) : null);

  /** Таблица полей; software = поля ПО */
  const table = (list, software) => h('div.table-wrap', h('table.list',
    h('thead', h('tr', h('th', 'Поле'), h('th', 'Формат'), h('th', software ? 'Относится к' : 'Применяется'), h('th', ''))),
    h('tbody', list.length ? list.map((d) => h('tr',
      h('td', h('strong', d.label)),
      formatCell(d),
      h('td', software ? targetLabel(d) : scopeLabel(d)),
      h('td.nowrap', { style: { textAlign: 'right' } },
        h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => openFieldModal({ def: d, software, onSaved: again }) }, icon('edit', 14)),
        h('button.btn.subtle.sm.icon', {
          title: 'Удалить',
          onclick: async () => {
            const where = !software ? 'у всех устройств' : d.target === 'software' ? 'у всех программ' : 'у всех установок ПО';
            if (!await confirmDialog({ title: `Удалить поле «${d.label}»?`, text: `Значения этого поля будут удалены ${where}.` })) return;
            run(async () => {
              await api.del((software ? '/api/software-fields/' : '/api/fields/') + d.id);
              toast('Поле удалено'); await loadMeta(); again();
            });
          },
        }, icon('trash', 14)))))
      : h('tr.empty', h('td', { colspan: 4 }, software ? 'Полей для ПО пока нет' : 'Дополнительных полей пока нет')))));

  clear(box,
    h('div.page-head', h('h2', 'Поля техники'), h('span.spacer'),
      h('button.btn.primary', { onclick: () => openFieldModal({ onSaved: again }) }, icon('plus'), 'Новое поле')),
    h('p.muted', { style: { marginTop: '-8px', marginBottom: '16px' } },
      'Поля можно добавить для всей техники, для отдельного типа или только для одного устройства (это делается на странице устройства). ',
      'Новые поля сразу появляются в карточках, в колонках списка, в поиске и в выгрузке Excel.'),
    table(defs, false),

    h('div.page-head', { style: { marginTop: '40px' } }, h('h2', 'Поля ПО'), h('span.spacer'),
      h('button.btn.primary', { onclick: () => openFieldModal({ software: true, onSaved: again }) }, icon('plus'), 'Новое поле для ПО')),
    h('p.muted', { style: { marginTop: '-8px', marginBottom: '16px' } },
      'Поля для программы в справочнике заполняются один раз и видны на всех устройствах, где она установлена ',
      '(тип лицензии, поставщик, договор). Поля для установки заполняются отдельно на каждом устройстве ',
      '(срок лицензии, кто установил). Значения ищутся поиском и попадают на лист «Установленное ПО» в Excel.'),
    table(swDefs, true));
}

/**
 * Окно создания/изменения доп. поля.
 * device — если открыто со страницы устройства (можно выбрать «только это устройство»)
 * def    — существующее поле для изменения
 */
/**
 * software — поле для ПО (target: 'software' | 'install'), а не для техники
 */
export function openFieldModal({ device, def, onSaved, software = false, target: presetTarget }) {
  const label = h('input', { type: 'text', value: def?.label || '', placeholder: 'Например: Дата покупки, Номер кабинета, Картридж' });
  const type = h('select', Object.entries(FIELD_TYPE_LABELS).map(([k, v]) => h('option', { value: k, selected: def?.field_type === k }, v)));
  const options = h('textarea', { rows: 4, placeholder: 'Каждый вариант с новой строки' });
  options.value = (def?.options || []).join('\n');
  const kind = h('select', state.meta.lookupKinds.map((k) => h('option', { value: k.code, selected: def?.lookup_kind === k.code }, k.name)));
  const optBox = h('label.field.wide', h('span', 'Варианты'), options);
  const kindBox = h('label.field.wide', h('span', 'Справочник'), kind,
    h('div.hint', 'Новые справочники создаются в разделе «Справочники»'));
  const upd = () => { optBox.classList.toggle('hidden', type.value !== 'select'); kindBox.classList.toggle('hidden', type.value !== 'lookup'); };
  type.addEventListener('change', upd); upd();

  // Область применения
  let scopeEl = null;
  let getScope = () => ({});
  if (software && !def) {
    let target = presetTarget || 'install';
    const opts = [
      ['install', 'Для установки на устройстве', 'своё значение на каждом компьютере: срок лицензии, кто установил, номер заявки'],
      ['software', 'Для программы в справочнике', 'одно значение для всех установок: тип лицензии, поставщик, номер договора'],
    ];
    scopeEl = h('div.field.wide', h('span.field-label', 'К чему относится поле'), h('div.stack',
      opts.map(([k, text, hint]) => h('label.check', { style: { alignItems: 'flex-start' } }, h('input', {
        type: 'radio', name: 'target', value: k, checked: k === target, onchange: () => { target = k; },
      }), h('span', text, h('div.hint', { style: { marginTop: 0 } }, hint))))));
    getScope = () => ({ target });
  } else if (!def) {
    const typeSel = h('select', state.meta.types.map((t) => h('option', { value: t.id, selected: device && t.id === device.type_id }, t.name)));
    const opts = [];
    if (device) opts.push(['device', `Только для этого устройства (${device.type_code}-${device.id})`]);
    if (device) opts.push(['type', `Для всех устройств типа «${device.type_name}»`]);
    else opts.push(['type', 'Для всех устройств выбранного типа']);
    opts.push(['all', 'Для всей техники']);
    let scope = opts[0][0];
    const radios = opts.map(([k, text]) => h('label.check', h('input', {
      type: 'radio', name: 'scope', value: k, checked: k === scope,
      onchange: () => { scope = k; typeSel.classList.toggle('hidden', !(scope === 'type' && !device)); },
    }), text));
    typeSel.classList.toggle('hidden', !(scope === 'type' && !device));
    scopeEl = h('div.field.wide', h('span.field-label', 'Где использовать поле'), h('div.stack', radios, typeSel));
    getScope = () => ({
      scope,
      type_id: scope === 'type' ? (device ? device.type_id : Number(typeSel.value)) : null,
      device_id: scope === 'device' ? device.id : null,
    });
  }

  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = { label: label.value, field_type: type.value, options: options.value, lookup_kind: kind.value, ...getScope() };
      const base = software ? '/api/software-fields' : '/api/fields';
      if (def) await api.put(`${base}/${def.id}`, body); else await api.post(base, body);
      m.close(); toast(def ? 'Поле изменено' : 'Поле добавлено');
      await loadMeta();
      onSaved && onSaved();
    }, save),
  }, def ? 'Сохранить' : 'Добавить поле');

  const m = modal({
    title: def ? 'Изменить поле' : software ? 'Новое поле для ПО' : 'Новое поле',
    body: h('div.form-grid',
      h('label.field.wide', h('span', 'Название поля'), label),
      h('label.field.wide', h('span', 'Формат значения'), type),
      optBox, kindBox, scopeEl),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}

