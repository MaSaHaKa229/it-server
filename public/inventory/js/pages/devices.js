// Список техники: поиск в реальном времени, фильтры-«чипы», колонки, сортировка, экспорт
import {
  h, clear, icon, api, toast, run, modal, popover, menu, multiSelectPopover, closePopover,
  confirmDialog, lozenge, typeDot, deviceKey, highlight, fmtDate, debounce, statusInfo,
} from '../ui.js';
import { state, isStaff, lookupItems, softwareItems, customDesc, displayValue } from '../store.js';
import { navigate } from '../app.js';
import { openCreateDevice } from './create.js';
import { moveDialog, bulkEditDialog, moveStyles } from './moves.js';

const PAGE = 50;
const DEFAULT_COLS = ['key', 'type', 'hostname', 'model', 'employee', 'department', 'ip_address', 'status', 'updated_at'];
const DEFAULT_CHIPS = ['type', 'status', 'department', 'employee', 'model', 'os'];

let extraChips = new Set(); // фильтры, добавленные через «Ещё»

export async function renderDevices(root, params) {
  const meta = state.meta;
  const P = state.perms;

  // ---------- состояние ----------
  const st = {
    q: params.get('q') || '',
    filters: safeJSON(params.get('f'), {}),
    sort: params.get('sort') || 'key',
    dir: params.get('dir') || 'desc',
    page: Math.max(0, Number(params.get('page')) || 0),
    cols: (params.get('cols') || localStorage.getItem('itdb.cols') || DEFAULT_COLS.join(',')).split(',').filter(Boolean),
    selected: new Set(),
  };

  // ---------- каталог колонок ----------
  const columns = [
    { key: 'key', label: 'Ключ', fixed: true, render: (d) => h('a.key-link', { href: `#/devices/${d.id}` }, highlight(deviceKey(d), st.q)) },
    { key: 'type', label: 'Тип', render: (d) => h('span.type-cell', typeDot(d), d.type_name) },
    ...meta.coreFields.map((f) => ({ key: f.key, label: f.label, render: (d) => highlight(d[f.key], st.q) })),
    ...meta.fieldDefs.map((d) => {
      const desc = customDesc(d);
      return { key: desc.key, label: d.label, render: (row) => highlight(displayValue(desc, row), st.q) };
    }),
    P.software ? { key: 'software', label: 'Установленное ПО', render: (d) => highlight(d.software, st.q) } : null,
    { key: 'status', label: 'Состояние', render: (d) => lozenge(d.status) },
    { key: 'updated_at', label: 'Изменено', render: (d) => h('span.muted.nowrap', fmtDate(d.updated_at)) },
  ].filter(Boolean);
  const colByKey = Object.fromEntries(columns.map((c) => [c.key, c]));
  st.cols = st.cols.filter((k) => colByKey[k]);
  if (!st.cols.includes('key')) st.cols.unshift('key');

  // ---------- каталог фильтров ----------
  const filterDefs = [
    { key: 'type', label: 'Тип', load: async () => meta.types.map((t) => ({ id: t.id, label: t.name, dot: t.color })) },
    { key: 'status', label: 'Состояние', load: async () => meta.statuses.map((s) => ({ id: s.key, label: s.label, dot: s.color })) },
    ...meta.coreFields.filter((f) => f.kind === 'lookup').map((f) => ({
      key: f.key, label: f.label,
      load: async () => [{ id: 0, label: '(не указано)' }, ...(await lookupItems(f.lookup))],
    })),
    P.software ? { key: 'software', label: 'ПО', load: softwareItems } : null,
    ...meta.coreFields.filter((f) => f.kind !== 'lookup').map((f) => ({ key: 'text.' + f.key, label: f.label, text: true })),
    ...meta.fieldDefs.map((d) => ({ key: 'text.f_' + d.id, label: d.label, text: true })),
  ].filter(Boolean);
  const labelCache = {};

  // ---------- DOM ----------
  const searchInput = h('input', { type: 'search', placeholder: 'Поиск по всем полям…', value: st.q, 'aria-label': 'Поиск' });
  const spinner = h('span.spinner.hidden');
  const chipsBox = h('div.row', { style: { flexWrap: 'wrap', gap: '6px' } });
  const bulkBox = h('div');
  const tableBox = h('div');
  const pagerBox = h('div');
  const countEl = h('span.muted');

  const colsBtn = h('button.btn', { onclick: () => columnsPopover(colsBtn) }, icon('columns'), 'Колонки');
  const exportBtn = P.export ? h('button.btn', { onclick: doExport, title: 'Скачать текущую выборку в Excel' }, icon('download'), 'Экспорт в Excel') : null;

  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'), h('span', 'Техника')),
    h('div.page-head', h('h1', 'Техника'), countEl, h('span.spacer'),
      isStaff() ? h('a.btn', { href: '#/import' }, icon('download'), 'Импорт из Excel') : null,
      isStaff() ? h('button.btn.primary', { onclick: () => openCreateDevice(st.filters.type?.length === 1 ? st.filters.type[0] : null) }, icon('plus'), 'Добавить') : null),
    h('div.toolbar',
      h('div.search-box', icon('search'), searchInput, spinner),
      chipsBox,
      h('span.spacer'),
      colsBtn, exportBtn),
    bulkBox, tableBox, pagerBox);

  // ---------- синхронизация с URL ----------
  function syncUrl() {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (Object.keys(st.filters).length) p.set('f', JSON.stringify(st.filters));
    if (st.sort !== 'key') p.set('sort', st.sort);
    if (st.dir !== 'desc') p.set('dir', st.dir);
    if (st.page) p.set('page', st.page);
    const url = '#/devices' + (p.toString() ? '?' + p : '');
    history.replaceState(null, '', url);
  }

  function apiParams() {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    const f = { ...st.filters };
    if (Object.keys(f).length) p.set('filters', JSON.stringify(f));
    p.set('sort', st.sort); p.set('dir', st.dir);
    return p;
  }

  // ---------- загрузка данных ----------
  let seq = 0;
  let data = { items: [], total: 0 };
  async function load() {
    const my = ++seq;
    spinner.classList.remove('hidden');
    const p = apiParams();
    p.set('limit', PAGE); p.set('offset', st.page * PAGE);
    try {
      const res = await api.get('/api/devices?' + p);
      if (my !== seq) return; // пришёл устаревший ответ
      data = res;
      if (!res.items.length && st.page > 0 && res.total) { st.page = 0; syncUrl(); return load(); }
      renderTable();
    } catch (e) {
      if (my === seq) clear(tableBox, h('div.empty-state', h('h3', 'Ошибка загрузки'), h('p', e.message)));
    } finally {
      if (my === seq) spinner.classList.add('hidden');
    }
  }
  const loadDebounced = debounce(() => { st.page = 0; syncUrl(); load(); }, 250);

  searchInput.addEventListener('input', () => { st.q = searchInput.value.trim(); loadDebounced(); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; st.q = ''; loadDebounced(); } });

  // ---------- чипы фильтров ----------
  function filterValue(fd) {
    if (fd.text) return (st.filters.text || {})[fd.key.slice(5)] || '';
    return st.filters[fd.key] || [];
  }
  function setFilter(fd, val) {
    if (fd.text) {
      const t = { ...(st.filters.text || {}) };
      const k = fd.key.slice(5);
      if (val) t[k] = val; else delete t[k];
      if (Object.keys(t).length) st.filters.text = t; else delete st.filters.text;
    } else if (val && val.length) {
      st.filters[fd.key] = fd.key === 'status' ? val : val.map(Number);
    } else delete st.filters[fd.key];
    st.page = 0; st.selected.clear();
    syncUrl(); renderChips(); load();
  }
  function renderChips() {
    const chips = filterDefs.filter((fd) => {
      const v = filterValue(fd);
      return DEFAULT_CHIPS.includes(fd.key) || extraChips.has(fd.key) || (fd.text ? !!v : v.length);
    });
    const els = chips.map((fd) => {
      const v = filterValue(fd);
      const on = fd.text ? !!v : v.length > 0;
      let text = fd.label;
      if (on) {
        if (fd.text) text += `: «${v}»`;
        else {
          const names = labelCache[fd.key];
          const first = names ? names.find((i) => String(i.id) === String(v[0])) : null;
          text += ': ' + (first ? first.label : fd.key === 'status' ? statusInfo(v[0]).label : '…') + (v.length > 1 ? ` +${v.length - 1}` : '');
        }
      }
      const btn = h('button.btn.chip' + (on ? '.on' : ''), text, icon('chevron'));
      btn.addEventListener('click', () => openChip(fd, btn));
      return btn;
    });
    const moreDefs = filterDefs.filter((fd) => !chips.includes(fd));
    const moreBtn = moreDefs.length ? h('button.btn.subtle', icon('filter'), 'Ещё') : null;
    moreBtn && moreBtn.addEventListener('click', () => menu(moreBtn, moreDefs.map((fd) => ({
      label: fd.label + (fd.text ? ' (содержит)' : ''),
      onClick: () => { extraChips.add(fd.key); renderChips(); const b = [...chipsBox.querySelectorAll('.chip')].find((x) => x.textContent.startsWith(fd.label)); b && openChip(fd, b); },
    }))));
    const anyOn = Object.keys(st.filters).length > 0 || st.q;
    clear(chipsBox, els, moreBtn,
      anyOn ? h('button.btn.link', { onclick: resetAll }, 'Сбросить') : null,
      anyOn ? h('button.btn.subtle', { onclick: saveFilter }, icon('star'), 'Сохранить фильтр') : null);
  }
  function openChip(fd, btn) {
    if (fd.text) {
      const input = h('input', { type: 'text', value: filterValue(fd), placeholder: 'Содержит…' });
      const apply = () => { closePopover(); setFilter(fd, input.value.trim()); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
      popover(btn, h('div', { style: { padding: '12px' } },
        h('label.field', h('span', fd.label + ' содержит'), input),
        h('div.row', { style: { marginTop: '8px', justifyContent: 'flex-end' } },
          h('button.btn.subtle.sm', { onclick: () => { closePopover(); extraChips.delete(fd.key); setFilter(fd, ''); } }, 'Очистить'),
          h('button.btn.primary.sm', { onclick: apply }, 'Применить'))), { width: 280 });
      setTimeout(() => input.focus(), 20);
      return;
    }
    multiSelectPopover(btn, {
      load: async () => (labelCache[fd.key] = await fd.load()),
      selected: filterValue(fd),
      searchable: !['status', 'type'].includes(fd.key),
      onChange: (vals) => setFilter(fd, vals),
    });
  }
  function resetAll() {
    st.filters = {}; st.q = ''; searchInput.value = ''; st.page = 0; extraChips = new Set();
    syncUrl(); renderChips(); load();
  }

  // ---------- таблица ----------
  function renderTable() {
    countEl.textContent = `${data.total} ${plural(data.total, 'устройство', 'устройства', 'устройств')}`;
    const cols = st.cols.map((k) => colByKey[k]).filter(Boolean);
    const staff = isStaff();

    const allCb = staff ? h('input', {
      type: 'checkbox', title: 'Выбрать все на странице',
      checked: data.items.length > 0 && data.items.every((d) => st.selected.has(d.id)),
      onchange: (e) => { data.items.forEach((d) => (e.target.checked ? st.selected.add(d.id) : st.selected.delete(d.id))); renderTable(); },
    }) : null;

    const head = h('tr',
      staff ? h('th.check-col', allCb) : null,
      cols.map((c) => h('th.sortable', {
        onclick: () => {
          if (st.sort === c.key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
          else { st.sort = c.key; st.dir = c.key === 'updated_at' || c.key === 'key' ? 'desc' : 'asc'; }
          syncUrl(); load();
        },
      }, c.label, st.sort === c.key ? h('span.arrow', st.dir === 'asc' ? '↑' : '↓') : null)));

    const rows = data.items.length ? data.items.map((d) => {
      const cb = staff ? h('input', {
        type: 'checkbox', checked: st.selected.has(d.id),
        onchange: (e) => { e.target.checked ? st.selected.add(d.id) : st.selected.delete(d.id); renderBulk(); tr.classList.toggle('selected', e.target.checked); },
      }) : null;
      const tr = h('tr.clickable' + (st.selected.has(d.id) ? '.selected' : ''), {
        onclick: (e) => {
          if (e.target.closest('a, input, button')) return;
          if (window.getSelection().toString()) return;
          if (e.ctrlKey || e.metaKey) window.open(`#/devices/${d.id}`, '_blank');
          else navigate('/devices/' + d.id);
        },
      },
      staff ? h('td.check-col', cb) : null,
      cols.map((c) => {
        const v = c.render(d);
        return h('td', { title: typeof d[c.key] === 'string' ? d[c.key] : null }, v);
      }));
      return tr;
    }) : h('tr.empty', h('td', { colspan: cols.length + (staff ? 1 : 0) },
      st.q || Object.keys(st.filters).length ? 'По вашему запросу ничего не найдено' : 'Техника ещё не добавлена'));

    clear(tableBox, h('div.table-wrap', h('table.list', h('thead', head), h('tbody', rows))));
    renderBulk();
    renderPager();
  }

  function renderPager() {
    const from = data.total ? st.page * PAGE + 1 : 0;
    const to = Math.min(data.total, (st.page + 1) * PAGE);
    const pages = Math.ceil(data.total / PAGE);
    clear(pagerBox, pages > 1 || data.total > 0 ? h('div.pager',
      h('span', `${from}–${to} из ${data.total}`),
      pages > 1 ? h('div.btn-group',
        h('button.btn', { disabled: st.page === 0, onclick: () => { st.page--; syncUrl(); load(); } }, '‹ Назад'),
        h('span.muted', { style: { padding: '6px 8px' } }, `${st.page + 1} / ${pages}`),
        h('button.btn', { disabled: st.page >= pages - 1, onclick: () => { st.page++; syncUrl(); load(); } }, 'Вперёд ›')) : null) : null);
  }

  function renderBulk() {
    if (!isStaff() || !st.selected.size) { clear(bulkBox); return; }
    const statusBtn = h('button.btn.sm', 'Изменить состояние', icon('chevron'));
    statusBtn.addEventListener('click', () => menu(statusBtn, meta.statuses.map((s) => ({
      label: s.label,
      onClick: () => run(async () => {
        await api.post('/api/devices/bulk', { ids: [...st.selected], action: 'status', value: s.key });
        toast(`Состояние изменено: ${st.selected.size} шт.`);
        window.dispatchEvent(new Event('itdb:changed'));
        load();
      }),
    }))));
    moveStyles();
    const done = () => { st.selected.clear(); load(); };
    clear(bulkBox, h('div.bulkbar',
      h('strong', `Выбрано: ${st.selected.size}`),
      statusBtn,
      h('button.btn.sm', { onclick: () => moveDialog([...st.selected].map((id) => ({ id })), done) }, 'Переместить…'),
      h('button.btn.sm', { onclick: () => bulkEditDialog([...st.selected], done) }, 'Изменить поля…'),
      h('button.btn.sm', {
        onclick: async () => {
          const n = st.selected.size;
          if (!await confirmDialog({ title: 'Удалить устройства?', text: `Будет удалено ${n} ${plural(n, 'устройство', 'устройства', 'устройств')} вместе с ПО, паролями и историей. Действие необратимо.` })) return;
          await run(async () => {
            await api.post('/api/devices/bulk', { ids: [...st.selected], action: 'delete' });
            st.selected.clear(); toast(`Удалено: ${n}`);
            window.dispatchEvent(new Event('itdb:changed'));
            load();
          });
        },
      }, icon('trash'), 'Удалить'),
      h('span.spacer'),
      h('button.btn.sm', { onclick: () => { st.selected.clear(); renderTable(); } }, 'Снять выделение')));
  }

  // ---------- колонки ----------
  function columnsPopover(anchor) {
    const content = h('div', h('div.menu-head', 'Показывать колонки'),
      columns.map((c) => h('label.menu-item',
        h('input', {
          type: 'checkbox', checked: st.cols.includes(c.key), disabled: c.fixed,
          onchange: (e) => {
            if (e.target.checked) {
              // вставляем в порядке каталога
              st.cols = columns.map((x) => x.key).filter((k) => k === c.key || st.cols.includes(k));
            } else st.cols = st.cols.filter((k) => k !== c.key);
            localStorage.setItem('itdb.cols', st.cols.join(','));
            renderTable();
          },
        }), c.label)),
      h('div.menu-sep'),
      h('div.menu-item', { onclick: () => { st.cols = [...DEFAULT_COLS]; localStorage.removeItem('itdb.cols'); closePopover(); renderTable(); } }, 'Сбросить по умолчанию'));
    popover(anchor, content, { width: 260, align: 'right' });
  }

  // ---------- экспорт ----------
  function doExport() {
    const p = apiParams();
    p.set('columns', st.cols.join(','));
    if (P.software) p.set('software_sheet', '1');
    const a = h('a', { href: '/inventory/api/export?' + p, download: '' });
    document.body.append(a); a.click(); a.remove();
    toast('Формируется файл Excel…', 'info');
  }

  // ---------- сохранение фильтра ----------
  function saveFilter() {
    const name = h('input', { type: 'text', placeholder: 'Например: Сломанные ПК бухгалтерии' });
    const shared = h('input', { type: 'checkbox' });
    const save = h('button.btn.primary', {
      onclick: () => run(async () => {
        await api.post('/api/filters', {
          name: name.value, is_shared: shared.checked,
          query: { q: st.q, filters: st.filters, sort: st.sort, dir: st.dir, cols: st.cols.join(',') },
        });
        m.close(); toast('Фильтр сохранён — он появился в боковой панели');
        window.dispatchEvent(new Event('itdb:changed'));
      }, save),
    }, 'Сохранить');
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    const m = modal({
      title: 'Сохранить фильтр', size: 'narrow',
      body: h('div.stack', { style: { gap: '12px' } },
        h('label.field', h('span', 'Название'), name),
        isStaff() ? h('label.check', shared, 'Доступен всем пользователям') : null,
        h('p.hint', 'Сохраняются строка поиска, фильтры, сортировка и набор колонок.')),
      footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
    });
  }

  renderChips();
  // Подгружаем названия для активных фильтров, чтобы подписи чипов были читаемыми
  Promise.all(filterDefs.filter((fd) => !fd.text && (st.filters[fd.key] || []).length && fd.key !== 'status')
    .map(async (fd) => { labelCache[fd.key] = await fd.load(); })).then(renderChips).catch(() => {});
  await load();
  if (!st.q) searchInput.focus({ preventScroll: true });
}

function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
