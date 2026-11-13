// Склад расходников и запчастей: остатки, приход, выдача на принтер, списание, история движения
import { h, clear, api, toast, run, modal, combobox, typeDot, fmtDate, debounce } from '../ui.js';
import { isStaff } from '../store.js';

let filt = { q: '', cat: '', low: false, archived: false };
let meta = { categories: {}, kinds: {} };

function stockStyles() {
  if (document.getElementById('stock-style')) return;
  const st = document.createElement('style');
  st.id = 'stock-style';
  st.textContent = `
    .st-qty { font-weight: 700; font-size: 15px; }
    .st-qty.low { color: #DE350B; }
    .st-row-arch td { opacity: .55; }
    .st-plus { color: #006644; font-weight: 600; }
    .st-minus { color: #BF2600; font-weight: 600; }
    .st-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
    .st-form .wide { grid-column: 1 / -1; }
    .st-dev-items .row { padding: 6px 0; border-bottom: 1px solid var(--n30); }
  `;
  document.head.append(st);
}

const sign = (m) => (m.qty > 0 ? h('span.st-plus', '+' + m.qty) : h('span.st-minus', String(m.qty)));
const devLabel = (d) => `${d.type_code}-${d.id} ${d.hostname || d.model || d.type_name || ''}`.trim();

/** Список техники для выбора: принтеры и МФУ — первыми */
async function deviceOptions(first) {
  const { items } = await api.get('/api/devices?limit=500&sort=hostname');
  const isPrn = (d) => /^(PRN|MFU)$/i.test(d.type_code) || /принтер|мфу|плоттер/i.test(d.type_name || '');
  const list = items.filter((d) => d.status !== 'written_off')
    .sort((a, b) => (first.has(b.id) - first.has(a.id)) || (isPrn(b) - isPrn(a)) || devLabel(a).localeCompare(devLabel(b), 'ru'));
  return list.map((d) => ({ id: d.id, label: `${d.hostname || d.model || d.type_name} (${d.type_code}-${d.id})`, sub: [d.hostname ? d.model : '', d.location].filter(Boolean).join(' · ') }));
}

/** Окно движения: kind — in | out | writeoff | adjust; device — техника по умолчанию (из карточки) */
export function moveDialog(item, kind, onDone, device = null) {
  const titles = { in: 'Приход на склад', out: 'Выдать', writeoff: 'Списать', adjust: 'Корректировка остатка' };
  const qty = h('input', { type: 'number', min: kind === 'adjust' ? -100000 : 1, value: kind === 'adjust' ? '' : 1, style: { width: '120px' } });
  const comment = h('input', { type: 'text', placeholder: kind === 'in' ? 'Например: счёт № 15 от 01.11, поставщик' : kind === 'out' ? 'Например: заявка #123' : 'Причина' });
  let dev = device ? { id: device.id, label: device.label } : null;
  const devBox = kind === 'out' ? combobox({ value: dev, placeholder: 'Принтер или другая техника (необязательно)…',
    load: () => deviceOptions(new Set(device ? [device.id] : [])), onChange: (v) => { dev = v; } }) : null;
  const save = h('button.btn.primary', titles[kind]);
  const m = modal({
    title: `${titles[kind]}: ${item.name}`,
    body: h('div.st-form',
      h('div.wide.muted', `Сейчас на складе: `, h('b', `${item.qty} ${item.unit}`)),
      h('label.field', h('span', kind === 'adjust' ? 'Изменение (+ или −)' : `Количество, ${item.unit}`), qty),
      kind === 'out' ? h('label.field.wide', h('span', 'Кому (техника)'), devBox.el) : null,
      h('label.field.wide', h('span', 'Комментарий'), comment),
      kind === 'adjust' ? h('p.hint.wide', 'Например, после пересчёта на складе: было 5, нашли 4 — укажите −1.') : null),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const r = await api.post(`/api/stock/${item.id}/move`, { kind, qty: Number(qty.value), device_id: dev ? dev.id : null, comment: comment.value });
    m.close();
    toast(`${titles[kind]}: готово. Осталось ${r.left} ${item.unit}`);
    onDone && onDone();
  }, save));
  setTimeout(() => qty.focus(), 50);
}

function itemDialog(item, onDone) {
  const cats = meta.categories;
  const name = h('input', { type: 'text', value: item?.name || '', placeholder: 'Картридж HP 59A (CF259A)' });
  const code = h('input', { type: 'text', value: item?.code || '', placeholder: 'CF259A' });
  const cat = h('select', Object.entries(cats).map(([k, l]) => h('option', { value: k, selected: (item?.category || 'cartridge') === k }, l)));
  const models = h('textarea', { rows: 2, placeholder: 'HP LaserJet Pro M404, HP LaserJet Pro MFP M428' }, item?.models || '');
  const unit = h('input', { type: 'text', value: item?.unit || 'шт.', style: { width: '90px' } });
  const minQty = h('input', { type: 'number', min: 0, value: item?.min_qty ?? 2, style: { width: '90px' } });
  const qty0 = h('input', { type: 'number', min: 0, value: 0, style: { width: '90px' } });
  const note = h('input', { type: 'text', value: item?.note || '' });
  const arch = h('input', { type: 'checkbox', checked: !!item?.archived });
  const save = h('button.btn.primary', item ? 'Сохранить' : 'Добавить');
  const m = modal({
    title: item ? 'Позиция склада' : 'Новая позиция склада',
    body: h('div.st-form',
      h('label.field.wide', h('span', 'Название'), name),
      h('label.field', h('span', 'Код (артикул)'), code, h('div.hint', 'Если код встречается в названии расходника, которое сообщает принтер, позиция подставится сама')),
      h('label.field', h('span', 'Вид'), cat),
      h('label.field.wide', h('span', 'Для моделей'), models, h('div.hint', 'Через запятую — к карточкам этих моделей позиция будет подсказываться при выдаче')),
      h('label.field', h('span', 'Единица'), unit),
      h('label.field', h('span', 'Минимум на складе'), minQty, h('div.hint', 'Меньше — придёт уведомление «мало на складе»; 0 — не следить')),
      !item ? h('label.field', h('span', 'Сейчас на складе'), qty0) : null,
      h('label.field.wide', h('span', 'Примечание'), note),
      item ? h('label.check.wide', arch, 'В архиве (больше не закупается, не показывается в списке)') : null),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const body = { name: name.value, code: code.value, category: cat.value, models: models.value, unit: unit.value,
      min_qty: Number(minQty.value), note: note.value, archived: arch.checked, qty: Number(qty0.value) };
    if (item) await api.put(`/api/stock/${item.id}`, body); else await api.post('/api/stock', body);
    m.close(); toast('Сохранено'); onDone && onDone();
  }, save));
}

function historyDialog(item, onDone) {
  const box = h('div', 'Загрузка…');
  const m = modal({ title: `Движение: ${item.name}`, body: box, footer: [h('button.btn', { onclick: () => m.close() }, 'Закрыть')], size: 'wide' });
  const load = async () => {
    const rows = await api.get(`/api/stock/moves?item=${item.id}`);
    clear(box, rows.length ? h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Когда'), h('th', 'Действие'), h('th', 'Кол-во'), h('th', 'Техника'), h('th', 'Комментарий'), h('th', 'Кто'), h('th', ''))),
      h('tbody', rows.map((r, i) => h('tr',
        h('td.nowrap', fmtDate(r.created_at)),
        h('td', meta.kinds[r.kind] || r.kind),
        h('td', sign(r)),
        h('td', r.device_id ? h('a', { href: `#/devices/${r.device_id}`, onclick: () => m.close() }, typeDot({ name: r.type_name, color: r.type_color }), ' ', devLabel({ ...r, id: r.device_id })) : ''),
        h('td.small', r.comment),
        h('td.small.muted', r.user_name || ''),
        h('td', i === 0 && isStaff() && Date.now() - new Date(r.created_at).getTime() < 864e5
          ? h('button.btn.sm.subtle', { title: 'Отменить ошибочную запись', onclick: () => run(async () => {
            await api.del(`/api/stock/moves/${r.id}`); toast('Запись отменена'); await load(); onDone && onDone();
          }) }, 'Отменить') : null)))))) : h('p.muted', 'Движений ещё не было'));
  };
  run(load);
}

export async function renderStock(root) {
  stockStyles();
  document.title = 'Склад — ИТ Инвентарь';
  const staff = isStaff();
  const q = h('input', { type: 'search', placeholder: 'Название, код, модель принтера', value: filt.q });
  const cat = h('select', { style: { width: 'auto' } }, h('option', { value: '' }, 'Все виды'));
  const low = h('input', { type: 'checkbox', checked: filt.low });
  const arch = h('input', { type: 'checkbox', checked: filt.archived });
  const box = h('div');
  let data = null;

  const draw = () => {
    Object.assign(filt, { q: q.value.trim(), cat: cat.value, low: low.checked, archived: arch.checked });
    const t = filt.q.toLowerCase();
    const rows = data.items.filter((i) => (filt.archived || !i.archived) && (!filt.cat || i.category === filt.cat) && (!filt.low || i.low)
      && (!t || `${i.name} ${i.code} ${i.models}`.toLowerCase().includes(t)));
    const lowN = data.items.filter((i) => i.low && !i.archived).length;
    clear(box,
      lowN ? h('div.error-box', { style: { marginBottom: '12px' } }, `Мало на складе: ${lowN} поз. — `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); low.checked = true; draw(); } }, 'показать')) : null,
      h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', 'Позиция'), h('th', 'Вид'), h('th', 'Для моделей'), h('th', { style: { textAlign: 'right' } }, 'Остаток'), h('th', 'Минимум'), h('th', 'Последнее движение'), h('th', ''))),
        h('tbody', rows.length ? rows.map((i) => h('tr' + (i.archived ? '.st-row-arch' : ''),
          h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); historyDialog(i, reload); } }, h('b', i.name)), i.code ? h('div.small.muted', i.code) : null),
          h('td.small', meta.categories[i.category] || i.category),
          h('td.small', i.models || h('span.muted', '—')),
          h('td', { style: { textAlign: 'right' } }, h('span.st-qty' + (i.low ? '.low' : ''), String(i.qty)), ' ', h('span.muted.small', i.unit)),
          h('td.small.muted', i.min_qty || '—'),
          h('td.small.muted', i.last_at ? fmtDate(i.last_at) : '—'),
          h('td.nowrap', { style: { textAlign: 'right' } }, staff ? [
            h('button.btn.sm', { onclick: () => moveDialog(i, 'in', reload) }, '+ Приход'), ' ',
            h('button.btn.sm', { disabled: i.qty <= 0, onclick: () => moveDialog(i, 'out', reload) }, 'Выдать'), ' ',
            h('button.btn.sm.subtle', { onclick: (e) => {
              import('../ui.js').then(({ menu }) => menu(e.currentTarget, [
                { label: 'Списать', onClick: () => moveDialog(i, 'writeoff', reload) },
                { label: 'Корректировка остатка', onClick: () => moveDialog(i, 'adjust', reload) },
                { label: 'Движение', onClick: () => historyDialog(i, reload) },
                '-',
                { label: 'Изменить позицию', onClick: () => itemDialog(i, reload) },
              ], { align: 'right' }));
            } }, '…')] : null))) : h('tr.empty', h('td', { colspan: 7 }, data.items.length ? 'Ничего не найдено' : 'Склад пуст — добавьте первую позицию'))))),
      h('p.muted.small', `Позиций: ${rows.length}`));
  };
  const reload = async () => { data = await api.get('/api/stock'); meta = data; draw(); };
  q.addEventListener('input', debounce(draw, 200));
  [cat, low, arch].forEach((x) => x.addEventListener('change', draw));

  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('span', 'Склад')),
    h('div.page-head', h('h1', 'Склад расходников и запчастей'), h('span.spacer'),
      h('a.btn', { href: '/inventory/api/stock/moves/export.xlsx', title: 'Все приходы, выдачи и списания' }, 'Движение (Excel)'), ' ',
      h('a.btn', { href: '/inventory/api/stock/export.xlsx', title: 'Остатки' }, 'Excel'), ' ',
      staff ? h('button.btn.primary', { onclick: () => itemDialog(null, reload) }, '+ Позиция') : null),
    h('p.muted', { style: { marginTop: '-8px' } }, 'Картриджи, барабаны, запчасти: приход, выдача на конкретный принтер, остатки. ',
      'Когда в принтере заканчивается тонер, уведомление подскажет, есть ли подходящий картридж на складе.'),
    h('div.toolbar.row', { style: { gap: '12px', alignItems: 'center' } },
      h('div.search-box', { style: { width: '320px' } }, q), cat,
      h('label.check.small', low, 'только «мало на складе»'), h('label.check.small', arch, 'показать архив')),
    box);
  await reload();
  Object.entries(meta.categories).forEach(([k, l]) => cat.append(h('option', { value: k, selected: filt.cat === k }, l)));
}

/** Блок в карточке принтера: подходящие позиции склада и что выдавалось */
export function deviceStockPanel(d, label) {
  stockStyles();
  const box = h('div.d-body', h('p.muted.small', 'Загрузка…'));
  const load = async () => {
    const r = await api.get(`/api/stock/for-device/${d.id}`);
    const k = (await api.get('/api/stock')).kinds;
    meta = { ...meta, kinds: k };
    clear(box,
      r.items.length ? h('div.st-dev-items', r.items.map((i) => h('div.row',
        h('div.grow', h('b', i.name), h('div.small.muted', `на складе: ${i.qty} ${i.unit}`)),
        isStaff() && i.qty > 0 ? h('button.btn.sm', { onclick: () => moveDialog(i, 'out', load, { id: d.id, label }) }, 'Выдать') : null)))
        : h('p.muted.small', { style: { margin: '6px 0' } }, 'Подходящих позиций нет. Укажите модель этого принтера в позиции склада (поле «Для моделей»).'),
      r.issued.length ? h('div', { style: { marginTop: '8px' } }, h('div.small.muted', 'Выдавалось:'),
        r.issued.slice(0, 5).map((m) => h('div.small', fmtDate(m.created_at, false), ' — ', m.item_name, ' ', h('b', String(Math.abs(m.qty))), ' ', m.unit))) : null,
      h('a.small', { href: '#/stock' }, 'Склад →'));
  };
  run(load);
  return h('div.details', { style: { marginTop: '16px' } }, h('div.d-head', 'Расходники со склада'), box);
}
