// Инвентаризация: плановая проверка наличия техники на выбранную дату
import { h, clear, api, toast, run, modal, confirmDialog, fmtDate, typeDot, debounce } from '../ui.js';
import { state, lookupItems } from '../store.js';

const STATE_LABEL = { pending: 'не проверено', found: 'на месте', missing: 'не найдено', moved: 'в другом месте' };
const STATE_CLS = { pending: '', found: '.green', missing: '.red', moved: '.yellow' };
const fmtDay = (d) => (d ? d.split('-').reverse().join('.') : '');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const STYLE = `
.au-progress { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--n30, #EBECF0); margin: 6px 0; min-width: 160px; }
.au-progress i { display: block; height: 100%; }
.au-seg { display: inline-flex; border: 1px solid var(--border, #DFE1E6); border-radius: 3px; overflow: hidden; }
.au-seg button { border: 0; background: #fff; padding: 3px 8px; font: inherit; font-size: 12px; cursor: pointer; color: var(--text-subtle, #42526E); border-right: 1px solid var(--border, #DFE1E6); }
.au-seg button:last-child { border-right: 0; }
.au-seg button:hover { background: var(--n20, #F4F5F7); }
.au-seg button.on.found { background: #E3FCEF; color: #006644; font-weight: 600; }
.au-seg button.on.missing { background: #FFEBE6; color: #BF2600; font-weight: 600; }
.au-seg button.on.moved { background: #FFF0B3; color: #7A5200; font-weight: 600; }
.au-seg button:disabled { cursor: default; }
.au-note { width: 100%; min-width: 140px; padding: 3px 6px; font-size: 13px; }
.au-check { max-height: 160px; overflow: auto; border: 1px solid var(--border, #DFE1E6); border-radius: 3px; padding: 6px 10px; display: flex; flex-direction: column; }
.au-check label { margin: 2px 0; }
.au-check label > input { margin-right: 6px; }
table.list.au-table td { vertical-align: middle; }
tr.au-row-found td:first-child { box-shadow: inset 3px 0 #36B37E; }
tr.au-row-missing td:first-child { box-shadow: inset 3px 0 #DE350B; }
tr.au-row-moved td:first-child { box-shadow: inset 3px 0 #FFAB00; }
`;
function style() {
  if (document.getElementById('au-style')) return;
  const s = h('style', { id: 'au-style' }); s.textContent = STYLE; document.head.append(s);
}

function progressBar(a) {
  const pct = (n) => `${a.total ? (n / a.total) * 100 : 0}%`;
  return h('div.au-progress', { title: `На месте: ${a.found}, не найдено: ${a.missing}, в другом месте: ${a.moved}, не проверено: ${a.pending}` },
    h('i', { style: { width: pct(a.found), background: '#36B37E' } }),
    h('i', { style: { width: pct(a.moved), background: '#FFAB00' } }),
    h('i', { style: { width: pct(a.missing), background: '#DE350B' } }));
}

// ====================== Список ======================
export async function renderAudits(root) {
  style();
  document.title = 'Инвентаризация — ИТ Инвентарь';
  const list = await api.get('/api/audits');
  const rows = list.map((a) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { location.hash = `#/audits/${a.id}`; } },
    h('td.nowrap', h('b', fmtDay(a.planned_date)),
      a.status === 'open' && a.planned_date < today() ? h('div.small', { style: { color: '#DE350B' } }, 'дата прошла') : null),
    h('td', h('a', { href: `#/audits/${a.id}` }, a.title), a.note ? h('div.small.muted', a.note) : null),
    h('td', h('span.lozenge' + (a.status === 'open' ? '.blue' : '.green'), a.status === 'open' ? 'идёт' : 'завершена')),
    h('td', { style: { minWidth: '180px' } }, progressBar(a),
      h('div.small.muted', `${a.total - a.pending} из ${a.total} проверено`, a.missing ? ` · не найдено: ${a.missing}` : '')),
    h('td.small.muted', a.created_by_name || '')));
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('span', 'Инвентаризация')),
    h('div.page-head', h('h1', 'Инвентаризация'), h('span.spacer'),
      h('button.btn.primary', { onclick: () => createDialog() }, '+ Новая инвентаризация')),
    h('p.muted', { style: { marginTop: '-8px' } },
      'Проверка наличия техники на выбранную дату: список составляется по типам, отделам и расположению; по каждому устройству ставится отметка. ',
      'Результат попадает в историю техники и выгружается в Excel. О дате проведения напомнит колокольчик.'),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Дата'), h('th', 'Название'), h('th', 'Состояние'), h('th', 'Ход проверки'), h('th', 'Создал'))),
      h('tbody', rows.length ? rows : h('tr.empty', h('td', { colspan: 5 }, 'Инвентаризаций ещё не было'))))));
}

async function createDialog() {
  const [deps, locs] = await Promise.all([lookupItems('department').catch(() => []), lookupItems('location').catch(() => [])]);
  const title = h('input', { type: 'text', value: `Инвентаризация ${new Date().getFullYear()}` });
  const date = h('input', { type: 'date', value: today() });
  const note = h('input', { type: 'text', placeholder: 'Например: комиссия, приказ №…' });
  const wo = h('input', { type: 'checkbox' });
  const count = h('span.muted');
  const group = (items) => {
    const boxes = items.map((x) => h('input', { type: 'checkbox', value: x.id }));
    return {
      el: h('div.au-check', items.length ? items.map((x, i) => h('label', boxes[i], x.label)) : h('span.muted.small', 'нет')),
      value: () => boxes.filter((b) => b.checked).map((b) => Number(b.value)),
      boxes,
    };
  };
  const types = group(state.meta.types.map((t) => ({ id: t.id, label: t.name })));
  const dep = group(deps);
  const loc = group(locs);
  const filters = () => ({ types: types.value(), departments: dep.value(), locations: loc.value(), include_written_off: wo.checked });
  const preview = debounce(async () => {
    try {
      const r = await api.post('/api/audits/preview', { filters: filters() });
      count.textContent = `В список попадёт техники: ${r.count}`;
    } catch (e) { count.textContent = e.message; }
  }, 200);
  [...types.boxes, ...dep.boxes, ...loc.boxes, wo].forEach((b) => b.addEventListener('change', preview));
  preview();
  const save = h('button.btn.primary', 'Создать');
  const m = modal({
    title: 'Новая инвентаризация', size: 'wide',
    body: h('div.stack', { style: { gap: '12px' } },
      h('div.form-grid',
        h('label.field', h('span', 'Название'), title),
        h('label.field', h('span', 'Дата проведения'), date)),
      h('label.field', h('span', 'Комментарий'), note),
      h('p.hint', { style: { margin: 0 } }, 'Какую технику проверять. Ничего не отмечено в группе — значит, без ограничения по ней.'),
      h('div.form-grid', { style: { gridTemplateColumns: '1fr 1fr 1fr' } },
        h('div.field', h('span', 'Типы техники'), types.el),
        h('div.field', h('span', 'Отделы'), dep.el),
        h('div.field', h('span', 'Расположение'), loc.el)),
      h('label.check', wo, 'Включить списанную технику'),
      count),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const a = await api.post('/api/audits', { title: title.value, planned_date: date.value, note: note.value, filters: filters() });
    m.close();
    toast(`Инвентаризация создана: ${a.total} устройств`);
    location.hash = `#/audits/${a.id}`;
  }, save));
}

// ====================== Одна инвентаризация ======================
const view = { filter: 'all', q: '' };

export async function renderAudit(root, id) {
  style();
  let data = await api.get(`/api/audits/${id}`);
  const box = h('div');
  const head = h('div');
  const search = h('input', { type: 'search', placeholder: 'Поиск: имя, модель, инв. №, пользователь, кабинет', value: view.q });
  search.addEventListener('input', debounce(() => { view.q = search.value.trim().toLowerCase(); drawTable(); }, 150));
  const reload = async () => { data = await api.get(`/api/audits/${id}`); drawHead(); drawTable(); };

  function drawHead() {
    const a = data.audit;
    const open = a.status === 'open';
    document.title = `${a.title} — Инвентаризация`;
    clear(head,
      h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('a', { href: '#/audits' }, 'Инвентаризация'), h('span.sep', '/'), h('span', a.title)),
      h('div.page-head',
        h('h1', a.title),
        h('span.lozenge' + (open ? '.blue' : '.green'), open ? 'идёт' : 'завершена'),
        h('span.spacer'),
        h('a.btn', { href: `/inventory/api/audits/${a.id}/export.xlsx` }, 'Отчёт в Excel'),
        open ? h('button.btn', { onclick: () => editDialog(a, reload) }, 'Изменить') : null,
        open ? h('button.btn.primary', { onclick: (e) => run(async () => {
          if (a.pending && !(await confirmDialog({ title: 'Завершить инвентаризацию?', text: `Не проверено устройств: ${a.pending}. Они останутся с отметкой «не проверено».`, okText: 'Завершить', danger: false }))) return;
          await api.post(`/api/audits/${a.id}/finish`, { force: true });
          toast('Инвентаризация завершена, результат записан в историю техники'); await reload();
        }, e.currentTarget) }, 'Завершить')
          : h('button.btn', { onclick: (e) => run(async () => { await api.post(`/api/audits/${a.id}/reopen`); await reload(); }, e.currentTarget) }, 'Открыть снова'),
        h('button.btn.subtle', { title: 'Удалить инвентаризацию', onclick: async () => {
          if (!(await confirmDialog({ title: 'Удалить инвентаризацию?', text: 'Список и отметки будут удалены (записи в истории техники останутся).' }))) return;
          run(async () => { await api.del(`/api/audits/${a.id}`); toast('Удалено'); location.hash = '#/audits'; });
        } }, 'Удалить')),
      h('div.row.wrap', { style: { gap: '24px', alignItems: 'center', marginBottom: '12px' } },
        h('div', h('span.muted', 'Дата проведения: '), h('b', fmtDay(a.planned_date)),
          open && a.planned_date < today() ? h('span', { style: { color: '#DE350B', marginLeft: '6px' } }, '(прошла)') : null),
        h('div', { style: { minWidth: '260px' } }, progressBar(a),
          h('span.small', `Проверено ${a.total - a.pending} из ${a.total}: на месте ${a.found}, не найдено ${a.missing}, в другом месте ${a.moved}`)),
        a.note ? h('div.muted', a.note) : null,
        a.finished_at ? h('div.muted.small', `Завершена ${fmtDate(a.finished_at)}${a.finished_by_name ? ' — ' + a.finished_by_name : ''}`) : null));
  }

  function drawTable() {
    const a = data.audit;
    const open = a.status === 'open';
    const counts = { all: data.items.length };
    for (const k of Object.keys(STATE_LABEL)) counts[k] = data.items.filter((x) => x.state === k).length;
    const q = view.q;
    const items = data.items.filter((x) => (view.filter === 'all' || x.state === view.filter)
      && (!q || [x.hostname, x.model, x.inv_number, x.serial_number, x.employee, x.location, x.department, `${x.type_code}-${x.device_id}`,
        x.snapshot?.hostname, x.snapshot?.location].some((v) => (v || '').toLowerCase().includes(q))));

    const setState = (x, st) => run(async () => {
      await api.patch(`/api/audits/${a.id}/items/${x.device_id}`, { state: x.state === st ? 'pending' : st });
      x.state = x.state === st ? 'pending' : st;
      const s = data.audit;
      for (const k of Object.keys(STATE_LABEL)) s[k] = data.items.filter((y) => y.state === k).length;
      drawHead();
      drawTable();
    });

    const tableRows = items.map((x) => {
      const s = x.snapshot || {};
      const btns = ['found', 'missing', 'moved'].map((st) => h('button' + '.' + st + (x.state === st ? '.on' : ''), { type: 'button', 'data-st': st, disabled: !open }, STATE_LABEL[st]));
      btns.forEach((b) => b.addEventListener('click', () => setState(x, b.dataset.st)));
      const note = h('input.au-note', { type: 'text', value: x.note || '', placeholder: 'комментарий', disabled: !open });
      note.addEventListener('change', () => run(async () => { await api.patch(`/api/audits/${a.id}/items/${x.device_id}`, { note: note.value }); x.note = note.value; }));
      const moved = (x.location || '') !== (s.location || '');
      return h('tr.au-row-' + x.state,
        h('td.nowrap', typeDot({ color: x.type_color || s.type_color, name: x.type_name || s.type_name }), ' ',
          x.deleted ? h('span.muted', `${s.type_code}-${x.device_id} (удалено)`) : h('a', { href: `#/devices/${x.device_id}` }, `${x.type_code}-${x.device_id}`)),
        h('td', h('b', x.hostname || s.hostname || ''), h('div.small.muted', x.model || s.model || '')),
        h('td.small', x.inv_number || s.inv_number ? `инв. ${x.inv_number || s.inv_number}` : '', h('div.muted', x.serial_number || s.serial_number || '')),
        h('td.small', x.employee || s.employee || ''),
        h('td.small', s.location || '', moved && x.location ? h('div', { style: { color: '#974F0C' } }, `сейчас: ${x.location}`) : null),
        h('td', h('div.au-seg', btns)),
        h('td', note),
        h('td.small.muted.nowrap', x.checked_at ? `${x.checked_by_name || ''}\n${fmtDate(x.checked_at)}` : ''));
    });

    // Добавить устройство, которого нет в списке
    const addInput = h('input', { type: 'search', placeholder: 'Ключ, имя, инв. или серийный №', style: { width: '260px' } });
    const addRes = h('span');
    const addBtn = h('button.btn', 'Найти и добавить');
    addBtn.addEventListener('click', () => run(async () => {
      const r = await api.get('/api/devices?limit=5&q=' + encodeURIComponent(addInput.value.trim()));
      const list = (r.items || []).filter((d) => !data.items.some((x) => x.device_id === d.id));
      if (!list.length) { clear(addRes, h('span.muted.small', ' Не найдено (или уже в списке)')); return; }
      clear(addRes, list.map((d) => h('button.btn.sm', { style: { marginLeft: '6px' }, onclick: () => run(async () => {
        await api.post(`/api/audits/${a.id}/items`, { device_id: d.id }); toast('Добавлено с отметкой «на месте»'); addInput.value = ''; clear(addRes); await reload();
      }) }, `${d.type_code}-${d.id} ${d.hostname || d.model || ''}`)));
    }, addBtn));

    clear(box,
      h('div.toolbar', { style: { flexWrap: 'wrap' } },
        h('div.tabs', { style: { margin: 0, borderBottom: 0 } }, [['all', 'Все'], ['pending', 'Не проверено'], ['found', 'На месте'], ['missing', 'Не найдено'], ['moved', 'В другом месте']]
          .map(([k, l]) => h('button.tab' + (view.filter === k ? '.active' : ''), { onclick: () => { view.filter = k; drawTable(); } }, l, ' ', h('span.badge', counts[k])))),
        h('span.spacer'),
        h('div.search-box', search),
        open && counts.pending ? h('button.btn', { onclick: async () => {
          if (!(await confirmDialog({ title: 'Отметить остальное «на месте»?', text: `Все непроверенные (${counts.pending}) получат отметку «на месте».`, okText: 'Отметить', danger: false }))) return;
          run(async () => { await api.post(`/api/audits/${a.id}/mark-rest`, { state: 'found' }); await reload(); });
        } }, 'Остальное — на месте') : null),
      h('div.table-wrap', h('table.list.au-table',
        h('thead', h('tr', h('th', 'Ключ'), h('th', 'Устройство'), h('th', 'Инв. / серийный №'), h('th', 'Пользователь'), h('th', 'Расположение'),
          h('th', 'Отметка'), h('th', 'Комментарий'), h('th', 'Проверил'))),
        h('tbody', tableRows.length ? tableRows : h('tr.empty', h('td', { colspan: 8 }, 'Нет устройств'))))),
      open ? h('div.row.wrap', { style: { marginTop: '12px', gap: '6px', alignItems: 'center' } },
        h('span.small.muted', 'Нашли устройство, которого нет в списке?'), addInput, addBtn, addRes) : null);
  }

  clear(root, head, box);
  drawHead();
  drawTable();
}

function editDialog(a, reload) {
  const title = h('input', { type: 'text', value: a.title });
  const date = h('input', { type: 'date', value: a.planned_date });
  const note = h('input', { type: 'text', value: a.note || '' });
  const save = h('button.btn.primary', 'Сохранить');
  const m = modal({
    title: 'Инвентаризация',
    body: h('div.stack', { style: { gap: '12px' } },
      h('label.field', h('span', 'Название'), title),
      h('label.field', h('span', 'Дата проведения'), date),
      h('label.field', h('span', 'Комментарий'), note)),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    await api.patch(`/api/audits/${a.id}`, { title: title.value, planned_date: date.value, note: note.value });
    m.close(); toast('Сохранено'); await reload();
  }, save));
}
