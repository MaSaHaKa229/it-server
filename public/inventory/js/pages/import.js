// Импорт техники из Excel / CSV — мастер из 4 шагов:
// 1. Файл → 2. Соответствие колонок → 3. Проверка совпадений → 4. Результат
import { h, clear, icon, api, toast, toastError, run } from '../ui.js';
import { state, loadMeta, invalidateLookups } from '../store.js';
import { plural } from './devices.js';

const STEPS = ['Файл', 'Колонки', 'Проверка', 'Готово'];
const PAGE = 200;

// Нормализация названия колонки — так же, как на сервере
const normHeader = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');

// Частые названия колонок в учётных таблицах
const SYNONYMS = {
  type: ['тип', 'типтехники', 'типустройства', 'видтехники', 'вид', 'категория', 'type', 'devicetype'],
  status: ['состояние', 'статус', 'status', 'state'],
  hostname: ['сетевоеимя', 'имякомпьютера', 'имяпк', 'компьютер', 'имяхоста', 'хост', 'hostname', 'host', 'computername', 'computer', 'pcname', 'dnsимя', 'имяустройства', 'name'],
  inv_number: ['инвентарныйномер', 'инвномер', 'инв', 'инвентарный', 'инвн', 'инвентарник', 'inventory', 'inventorynumber', 'invnumber', 'inv', 'assettag'],
  model: ['модель', 'model', 'модельпк', 'модельустройства', 'марка', 'маркамодель'],
  cpu: ['процессор', 'cpu', 'цп', 'processor'],
  ram: ['озу', 'ram', 'память', 'оперативнаяпамять', 'memory', 'объемозу'],
  storage: ['накопитель', 'диск', 'hdd', 'ssd', 'жесткийдиск', 'storage', 'disk', 'накопители'],
  os: ['ос', 'os', 'операционнаясистема', 'система', 'windows'],
  employee: ['пользователь', 'сотрудник', 'фио', 'фиосотрудника', 'фиопользователя', 'ответственный', 'владелец', 'работник', 'user', 'username', 'owner'],
  department: ['отдел', 'подразделение', 'департамент', 'служба', 'управление', 'department', 'dept'],
  location: ['расположение', 'кабинет', 'каб', 'помещение', 'местоположение', 'местонахождение', 'location', 'room', 'office'],
  serial_number: ['серийныйномер', 'серийный', 'серийник', 'заводскойномер', 'sn', 'serial', 'serialnumber', 'сн'],
  ip_address: ['ip', 'ipадрес', 'адресip', 'ipaddress', 'ipv4'],
  mac_address: ['mac', 'macадрес', 'macaddress', 'физическийадрес'],
  specs: ['характеристики', 'прочиехарактеристики', 'конфигурация', 'specs', 'specification'],
  notes: ['примечание', 'примечания', 'комментарий', 'комментарии', 'описание', 'notes', 'comment', 'comments'],
};

export async function renderImport(root) {
  document.title = 'Импорт из Excel — ИТ Инвентарь';
  await loadMeta();

  const st = {
    step: 0,
    filename: '', sheets: [], sheet: 0, headerRow: 0,
    targets: [], saved: {},
    columns: [], autoHint: [],
    defaults: { type_id: '', status: state.meta.statuses[0]?.key || '' },
    matchFields: new Set(), remember: true,
    preview: null, decisions: [], mergeMode: 'fill', filter: 'all', page: 0,
    result: null,
  };

  const body = h('div');
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('a', { href: '#/devices' }, 'Техника'), h('span.sep', '/'), h('span', 'Импорт')),
    h('div.page-head', h('h1', 'Импорт техники из Excel')),
    body);

  const go = (step) => { st.step = step; draw(); window.scrollTo(0, 0); };
  const tracker = () => h('div.steps', STEPS.map((name, i) => h('div.step' + (i === st.step ? '.cur' : i < st.step ? '.done' : ''),
    h('span.num', i < st.step ? '✓' : String(i + 1)), h('span', name))));

  function draw() {
    const views = [stepFile, stepColumns, stepReview, stepDone];
    clear(body, tracker(), views[st.step]());
  }

  // ======================= Шаг 1. Файл =======================
  function stepFile() {
    const input = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv', class: 'hidden' });
    const zone = h('div.dropzone', { tabindex: '0', role: 'button' },
      icon('download', 32),
      h('div', h('strong', 'Перетащите файл сюда'), ' или ', h('a', { href: '#' }, 'выберите на компьютере')),
      h('div.muted.small', 'Excel (.xlsx) или CSV. Старый формат .xls сначала сохраните в Excel как .xlsx'));
    const open = (e) => { e?.preventDefault(); input.click(); };
    zone.addEventListener('click', open);
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => input.files[0] && load(input.files[0]));

    async function load(file) {
      if (file.size > 20 * 1024 * 1024) { toastError(new Error('Файл больше 20 МБ')); return; }
      clear(zone, h('span.spinner'), h('div', 'Читаю «', file.name, '»…'));
      try {
        const data = await new Promise((ok, ko) => {
          const fr = new FileReader();
          fr.onload = () => ok(String(fr.result).split(',')[1] || '');
          fr.onerror = () => ko(new Error('Не удалось прочитать файл'));
          fr.readAsDataURL(file);
        });
        const [parsed, tg] = await Promise.all([
          api.post('/api/import/parse', { filename: file.name, data }),
          api.get('/api/import/targets'),
        ]);
        if (!parsed.sheets.length) throw new Error('В файле нет данных');
        Object.assign(st, { filename: file.name, sheets: parsed.sheets, targets: tg.targets, saved: tg.mappings, sheet: 0 });
        st.headerRow = guessHeaderRow(st.sheets[0].rows);
        autoMap();
        draw();
      } catch (e) {
        toastError(e);
        draw();
      }
    }

    if (!st.sheets.length) {
      return h('div', zone, input,
        h('div.import-help',
          h('h3', 'Как это работает'),
          h('ol',
            h('li', 'Загрузите таблицу — подойдёт любой порядок и любые названия колонок.'),
            h('li', 'Укажите, какая колонка файла соответствует какому полю на сайте. Сайт угадает знакомые названия и запомнит ваш выбор для следующих файлов.'),
            h('li', 'Сайт найдёт технику, которая уже есть в базе (по сетевому имени, инвентарному или серийному номеру и т. п.), и для каждой такой строки спросит: добавить новую единицу или объединить со старой.'),
            h('li', 'Новые модели, сотрудники, отделы и другие значения справочников будут добавлены автоматически.'))));
    }

    // Файл прочитан: выбор листа и строки заголовков
    const sheet = st.sheets[st.sheet];
    const sheetSel = st.sheets.length > 1 ? h('select', {
      onchange: (e) => { st.sheet = Number(e.target.value); st.headerRow = guessHeaderRow(st.sheets[st.sheet].rows); autoMap(); draw(); },
    }, st.sheets.map((s, i) => h('option', { value: i, selected: i === st.sheet }, `${s.name} (${s.rows.length} стр.)`))) : null;
    const headSel = h('select', {
      onchange: (e) => { st.headerRow = Number(e.target.value); autoMap(); draw(); },
    }, sheet.rows.slice(0, 30).map((r, i) => h('option', { value: i, selected: i === st.headerRow },
      `Строка ${i + 1}: ${r.filter(Boolean).slice(0, 5).join(' | ').slice(0, 90) || '(пустая)'}`)));
    const dataRows = sheet.rows.slice(st.headerRow + 1);
    const head = sheet.rows[st.headerRow] || [];
    const width = head.length;

    return h('div',
      h('div.file-card', icon('list', 20), h('div.grow', h('strong', st.filename),
        h('div.muted.small', `${dataRows.length} ${plural(dataRows.length, 'строка', 'строки', 'строк')} данных`)),
        h('button.btn', { onclick: () => { st.sheets = []; draw(); } }, 'Выбрать другой файл')),
      h('div.form-grid', { style: { margin: '20px 0' } },
        sheetSel ? h('label.field', h('span', 'Лист'), sheetSel) : null,
        h('label.field' + (sheetSel ? '' : '.wide'), h('span', 'Строка с названиями колонок'), headSel,
          h('div.hint', 'Если над таблицей есть заголовок или пустые строки — выберите строку, где написаны названия колонок'))),
      h('h4', { style: { marginBottom: '8px' } }, 'Первые строки'),
      h('div.table-wrap', h('table.list.preview',
        h('thead', h('tr', h('th', '№'), Array.from({ length: width }, (_, c) => h('th', head[c] || colName(c))))),
        h('tbody', dataRows.slice(0, 6).map((r, i) => h('tr', h('td.muted', st.headerRow + i + 2),
          Array.from({ length: width }, (_, c) => h('td', r[c] || ''))))))),
      h('div.wizard-foot',
        h('span.spacer'),
        h('button.btn.primary', { disabled: !dataRows.length, onclick: () => go(1) }, 'Далее: колонки')));
  }

  function guessHeaderRow(rows) {
    // Строка с наибольшим числом заполненных ячеек среди первых 20, в которой почти нет чисел
    let best = 0, bestScore = -1;
    rows.slice(0, 20).forEach((r, i) => {
      const filled = r.filter((v) => v !== '');
      const textual = filled.filter((v) => !/^[\d.,\s-]+$/.test(v)).length;
      const score = filled.length + textual * 0.5;
      if (filled.length >= 2 && score > bestScore + 0.5) { best = i; bestScore = score; }
    });
    return best;
  }

  /** Автоматически подобрать поля для колонок */
  function autoMap() {
    const sheet = st.sheets[st.sheet];
    const head = sheet.rows[st.headerRow] || [];
    const valid = new Set(st.targets.map((t) => t.key).concat('skip'));
    const byLabel = new Map(st.targets.map((t) => [normHeader(t.label.replace(' (доп. поле)', '')), t.key]));
    const used = new Set();
    st.columns = []; st.autoHint = [];

    // 1) запомненные соответствия и точные совпадения
    head.forEach((name, c) => {
      const n = normHeader(name);
      let t = '', hint = '';
      if (n && st.saved[n] && valid.has(st.saved[n]) && !used.has(st.saved[n])) { t = st.saved[n]; hint = 'запомнено'; }
      else if (n && byLabel.has(n) && !used.has(byLabel.get(n))) { t = byLabel.get(n); hint = 'распознано'; }
      else if (n) {
        const syn = Object.entries(SYNONYMS).find(([key, list]) => list.includes(n) && valid.has(key) && !used.has(key));
        if (syn) { t = syn[0]; hint = 'распознано'; }
      }
      if (t && t !== 'skip') used.add(t);
      st.columns[c] = t; st.autoHint[c] = hint;
    });
    // 2) частичные совпадения («ФИО ответственного сотрудника» → Пользователь)
    head.forEach((name, c) => {
      if (st.columns[c]) return;
      const n = normHeader(name);
      if (!n) return;
      const found = Object.entries(SYNONYMS).find(([key, list]) => valid.has(key) && !used.has(key) &&
        list.some((s) => partial(n, s)));
      if (found) { st.columns[c] = found[0]; st.autoHint[c] = 'распознано'; used.add(found[0]); }
    });
    // Пустые колонки без названия не загружаем
    st.columns = Array.from({ length: head.length }, (_, c) => st.columns[c] || '');
    resetMatchFields();
  }

  /** Частичное совпадение названия: «ФИО ответственного» ≈ «ответственный», «Инв. номер ПК» ≈ «инвномер» */
  function partial(n, s) {
    if (s.length >= 4 && n.includes(s)) return true;
    if (s.length >= 7 && n.includes(s.slice(0, -2))) return true; // другое окончание слова
    return ['фио', 'инв', 'каб'].includes(s) && n.startsWith(s);
  }

  function resetMatchFields() {
    st.matchFields = new Set(st.columns.filter((k) => st.targets.find((t) => t.key === k)?.matchable &&
      ['hostname', 'inv_number', 'serial_number', 'ip_address', 'mac_address'].includes(k)));
  }

  // ======================= Шаг 2. Колонки =======================
  function stepColumns() {
    const sheet = st.sheets[st.sheet];
    const head = sheet.rows[st.headerRow] || [];
    const dataRows = sheet.rows.slice(st.headerRow + 1);
    const tLabel = (k) => st.targets.find((t) => t.key === k)?.label || k;

    const groups = [
      ['Основное', st.targets.filter((t) => ['type', 'status'].includes(t.key))],
      ['Характеристики', st.targets.filter((t) => !['type', 'status'].includes(t.key) && !t.key.startsWith('f_'))],
      ['Дополнительные поля', st.targets.filter((t) => t.key.startsWith('f_'))],
    ].filter(([, list]) => list.length);

    const rows = head.map((name, c) => {
      const samples = [...new Set(dataRows.map((r) => r[c]).filter(Boolean))].slice(0, 3);
      if (!name && !samples.length) return null; // полностью пустая колонка
      const sel = h('select', {
        onchange: (e) => {
          const v = e.target.value;
          // Одно поле — одна колонка: снимаем выбор с другой колонки
          const other = st.columns.findIndex((k, i) => i !== c && k === v && v && v !== 'skip');
          if (other >= 0) { st.columns[other] = ''; toast(`Колонка «${head[other] || colName(other)}» больше не загружается в «${tLabel(v)}»`, 'info'); }
          st.columns[c] = v; st.autoHint[c] = '';
          resetMatchFields(); draw();
        },
      },
      h('option', { value: '' }, '— не загружать —'),
      groups.map(([g, list]) => h('optgroup', { label: g }, list.map((t) => h('option', { value: t.key, selected: st.columns[c] === t.key }, t.label)))));
      return h('tr' + (st.columns[c] ? '' : '.off'),
        h('td', h('strong', name || h('span.muted', colName(c))), st.autoHint[c] ? h('div.small', h('span.lozenge.green', st.autoHint[c])) : null),
        h('td.muted', { style: { whiteSpace: 'normal' } }, samples.length ? samples.join(' · ') : h('i', 'пусто')),
        h('td', { style: { minWidth: '240px' } }, sel));
    });

    const mapped = st.columns.filter((k) => k && k !== 'skip');
    const hasTypeCol = mapped.includes('type');
    const typeSel = h('select', { onchange: (e) => { st.defaults.type_id = e.target.value; draw(); } },
      h('option', { value: '' }, hasTypeCol ? '— не указывать (ошибка в строке) —' : '— выберите тип —'),
      state.meta.types.map((t) => h('option', { value: t.id, selected: String(t.id) === String(st.defaults.type_id) }, t.name)));
    const statusSel = h('select', { onchange: (e) => { st.defaults.status = e.target.value; } },
      state.meta.statuses.map((s) => h('option', { value: s.key, selected: s.key === st.defaults.status }, s.label)));

    const matchable = mapped.filter((k) => st.targets.find((t) => t.key === k)?.matchable);
    const matchBox = matchable.length
      ? h('div.stack', matchable.map((k) => h('label.check', h('input', {
        type: 'checkbox', checked: st.matchFields.has(k),
        onchange: (e) => { e.target.checked ? st.matchFields.add(k) : st.matchFields.delete(k); },
      }), tLabel(k))))
      : h('p.muted.small', 'Нет подходящих колонок: сопоставьте сетевое имя, инвентарный или серийный номер, IP или MAC — тогда сайт сможет найти уже существующую технику.');

    const typeMissing = !hasTypeCol && !st.defaults.type_id;
    const remember = h('input', { type: 'checkbox', checked: st.remember, onchange: (e) => { st.remember = e.target.checked; } });
    const next = h('button.btn.primary', {
      disabled: !mapped.length || typeMissing,
      onclick: () => run(async () => {
        await doPreview();
        go(2);
      }, next),
    }, 'Далее: проверка');

    return h('div',
      h('p.muted', { style: { marginBottom: '12px' } },
        'Для каждой колонки файла выберите поле на сайте. Колонки, которые не нужны, оставьте «не загружать». ',
        'Пустые ячейки ничего не затирают.'),
      h('div.table-wrap', h('table.list.mapping',
        h('thead', h('tr', h('th', 'Колонка в файле'), h('th', 'Примеры значений'), h('th', 'Поле на сайте'))),
        h('tbody', rows))),
      h('div.form-grid', { style: { marginTop: '24px' } },
        h('div.perm-box',
          h('strong', hasTypeCol ? 'Тип техники, если в строке не указан' : 'Тип техники для всех строк', typeMissing ? h('span.req', ' *') : null),
          h('div', { style: { margin: '8px 0 12px' } }, typeSel),
          h('strong', 'Состояние по умолчанию'),
          h('div', { style: { marginTop: '8px' } }, statusSel),
          h('div.hint', mapped.includes('status') ? 'Используется, если в строке состояние не указано или не распознано' : 'Будет у всей новой техники из файла')),
        h('div.perm-box',
          h('strong', 'Как искать технику, которая уже есть в базе'),
          h('div.hint', { style: { margin: '4px 0 10px' } }, 'Строка считается совпадением, если хотя бы одно отмеченное поле совпадает с существующей техникой. Регистр, пробелы и домен в сетевом имени не учитываются.'),
          matchBox)),
      h('label.check', { style: { marginTop: '16px' } }, remember, 'Запомнить выбранные соответствия колонок для следующих файлов'),
      typeMissing ? h('p.error-box', { style: { marginTop: '12px' } }, 'Выберите тип техники или сопоставьте колонку с типом') : null,
      h('div.wizard-foot',
        h('button.btn', { onclick: () => go(0) }, '‹ Назад'),
        h('span.spacer'),
        h('span.muted', `Будет загружено колонок: ${mapped.length}`),
        next));
  }

  function payload() {
    const sheet = st.sheets[st.sheet];
    const width = (sheet.rows[st.headerRow] || []).length;
    return {
      filename: st.filename,
      rows: sheet.rows.slice(st.headerRow + 1).map((r) => r.slice(0, width)),
      columns: st.columns.map((k) => (k && k !== 'skip' ? k : '')),
      defaults: st.defaults,
      matchFields: [...st.matchFields],
    };
  }

  async function doPreview() {
    st.preview = await api.post('/api/import/preview', payload());
    // Действия по умолчанию: совпадения — ждут решения редактора, остальное — добавить
    st.decisions = st.preview.rows.map((r) => {
      if (r.empty || r.errors.length) return null;
      if (needsDecision(r)) return null; // совпадение с базой или повтор в файле — решает редактор
      return { action: 'new' };
    });
    st.filter = st.preview.rows.some((r) => !r.errors.length && needsDecision(r)) ? 'match' : 'all';
    st.page = 0;
  }

  // ======================= Шаг 3. Проверка =======================
  function stepReview() {
    const P = st.preview;
    const rows = P.rows.map((r, i) => ({ ...r, i, excelRow: st.headerRow + i + 2 }));
    const real = rows.filter((r) => !r.empty);
    const cnt = {
      all: real.length,
      new: real.filter((r) => !r.errors.length && !needsDecision(r)).length,
      match: real.filter((r) => !r.errors.length && needsDecision(r)).length,
      err: real.filter((r) => r.errors.length).length,
      warn: real.filter((r) => !r.errors.length && r.warnings.length).length,
    };
    const undecided = real.filter((r) => !r.errors.length && needsDecision(r) && !st.decisions[r.i]).length;

    const setAll = (action) => {
      rows.forEach((r) => {
        if (r.empty || r.errors.length || !needsDecision(r)) return;
        if (action === 'merge') {
          // Повтор только внутри файла объединить не с чем — такие строки остаются на выбор
          if (r.matches.length) st.decisions[r.i] = { action: 'merge', target: r.matches[0].id };
        } else st.decisions[r.i] = { action };
      });
      draw();
    };

    const list = rows.filter((r) => !r.empty && (
      st.filter === 'all' ? true
        : st.filter === 'new' ? !r.errors.length && !needsDecision(r)
          : st.filter === 'match' ? !r.errors.length && needsDecision(r)
            : st.filter === 'err' ? r.errors.length
              : !r.errors.length && r.warnings.length));
    const pageRows = list.slice(st.page * PAGE, (st.page + 1) * PAGE);
    const pages = Math.ceil(list.length / PAGE);

    const tab = (key, label, n, cls = '') => h('button.tab' + (st.filter === key ? '.active' : ''),
      { onclick: () => { st.filter = key; st.page = 0; draw(); } }, label, ' ', h('span.badge' + cls, n));

    const newLookups = Object.entries(P.newLookups || {});
    const commit = h('button.btn.primary', {
      disabled: undecided > 0 || !real.some((r) => st.decisions[r.i] && st.decisions[r.i].action !== 'skip'),
      onclick: () => run(async () => {
        const p = payload();
        const remember = st.remember ? (st.sheets[st.sheet].rows[st.headerRow] || [])
          .map((name, c) => ({ header: name, target: st.columns[c] || 'skip' })).filter((m) => m.header) : null;
        st.result = await api.post('/api/import/commit', { ...p, decisions: st.decisions, mergeMode: st.mergeMode, remember });
        invalidateLookups();
        window.dispatchEvent(new Event('itdb:changed'));
        go(3);
      }, commit),
    }, 'Импортировать');

    return h('div',
      h('div.import-stats',
        stat(cnt.new, 'новых', 'Будут добавлены'),
        stat(cnt.match, 'совпадений', 'Уже есть в базе или повторяется в файле — нужно решение', cnt.match ? 'warn' : ''),
        stat(cnt.err, 'с ошибками', 'Не будут загружены', cnt.err ? 'err' : ''),
        newLookups.length ? h('div.import-stat',
          h('div.n', newLookups.reduce((a, [, v]) => a + v.length, 0)),
          h('div.l', 'новых значений справочников'),
          h('div.small.muted', { style: { whiteSpace: 'normal' } }, newLookups.map(([k, v]) => `${k}: ${v.slice(0, 4).join(', ')}${v.length > 4 ? ` и ещё ${v.length - 4}` : ''}`).join('; '))) : null),

      cnt.match ? h('div.perm-box', { style: { marginBottom: '16px' } },
        h('div.row', { style: { flexWrap: 'wrap', gap: '8px' } },
          h('strong', 'Для всех совпадений:'),
          h('button.btn.sm', { onclick: () => setAll('merge') }, 'Объединить с существующей'),
          h('button.btn.sm', { onclick: () => setAll('new') }, 'Добавить как новые'),
          h('button.btn.sm', { onclick: () => setAll('skip') }, 'Пропустить')),
        h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap', gap: '16px' } },
          h('strong', 'При объединении:'),
          h('label.check', h('input', { type: 'radio', name: 'mm', checked: st.mergeMode === 'fill', onchange: () => { st.mergeMode = 'fill'; } }),
            'дописать только пустые поля'),
          h('label.check', h('input', { type: 'radio', name: 'mm', checked: st.mergeMode === 'overwrite', onchange: () => { st.mergeMode = 'overwrite'; } }),
            'заменить значениями из файла'))) : null,

      h('div.tabs',
        tab('all', 'Все', cnt.all),
        cnt.match ? tab('match', 'Совпадения', cnt.match, undecided ? '.warn' : '') : null,
        tab('new', 'Новые', cnt.new),
        cnt.warn ? tab('warn', 'Предупреждения', cnt.warn) : null,
        cnt.err ? tab('err', 'Ошибки', cnt.err, '.err') : null),

      h('div.table-wrap', { style: { borderTop: 0 } }, h('table.list.review',
        h('thead', h('tr', h('th', 'Строка'), h('th', 'Данные из файла'), h('th', 'Проверка'), h('th', { style: { width: '260px' } }, 'Действие'))),
        h('tbody', pageRows.length ? pageRows.map(reviewRow) : h('tr.empty', h('td', { colspan: 4 }, 'Нет строк'))))),
      pages > 1 ? h('div.pager', h('span', `Показаны ${st.page * PAGE + 1}–${Math.min(list.length, (st.page + 1) * PAGE)} из ${list.length}`),
        h('div.btn-group',
          h('button.btn', { disabled: st.page === 0, onclick: () => { st.page--; draw(); } }, '‹'),
          h('button.btn', { disabled: st.page >= pages - 1, onclick: () => { st.page++; draw(); } }, '›'))) : null,

      h('div.wizard-foot',
        h('button.btn', { onclick: () => go(1) }, '‹ Назад'),
        h('span.spacer'),
        undecided ? h('span.lozenge.yellow', `Осталось решить по совпадениям: ${undecided}`) : null,
        commit));
  }

  function stat(n, label, sub, cls = '') {
    return h('div.import-stat' + (cls ? '.' + cls : ''), h('div.n', n), h('div.l', label), h('div.small.muted', sub));
  }

  function reviewRow(r) {
    const main = ['hostname', 'inv_number', 'model', 'serial_number'];
    const vals = r.values;
    const headline = vals.filter((v) => main.includes(v.key)).map((v) => v.value).join(' · ') || vals[0]?.value || '—';
    const rest = vals.filter((v) => !main.includes(v.key));
    const dec = st.decisions[r.i];

    // Проверка
    let check;
    if (r.errors.length) {
      check = h('div', r.errors.map((e) => h('div.text-err', '✕ ', e)));
    } else if (r.matches.length) {
      check = h('div', r.matches.map((m) => {
        const det = h('details.diff',
          h('summary',
            'Совпадает с ', h('a', { href: `#/devices/${m.id}`, target: '_blank' }, m.key), ' ', h('span.muted', m.title),
            h('div.small.muted', 'по: ', m.by.join(', ')),
            h('div.small', m.identical ? h('span.lozenge.green', 'данные совпадают') : h('span.lozenge.yellow', `отличается полей: ${m.diff.length}`))),
          m.diff.length ? h('table.difftable', m.diff.map((d) => h('tr',
            h('td.muted', d.label), h('td', d.old == null ? h('i.muted', 'пусто') : h('span.old', d.old)), h('td', '→'), h('td', h('strong', d.new))))) : null,
          m.typeDiffers ? h('div.small.muted', `В базе это «${m.typeDiffers}» — при объединении тип не меняется`) : null);
        return det;
      }));
    } else if (r.dupOf != null) {
      check = h('div', h('span.lozenge.yellow', 'повтор в файле'),
        h('div.small.muted', { style: { marginTop: '4px' } }, `Совпадает со строкой ${st.headerRow + r.dupOf + 2} этого файла`));
    } else {
      check = h('span.lozenge.blue', 'новая');
    }
    const notes = [
      ...r.warnings.map((w) => h('div.small.text-warn', '⚠ ', w)),
      r.dupOf != null && r.matches.length ? h('div.small.text-warn', `⚠ Также повторяет строку ${st.headerRow + r.dupOf + 2} этого файла`) : null,
    ];

    // Действие
    let action;
    if (r.errors.length) action = h('span.muted', 'не загружается');
    else {
      const opts = r.matches.length
        ? [h('option', { value: '' }, '— выберите —'),
          ...r.matches.map((m) => h('option', { value: 'merge:' + m.id }, `Объединить с ${m.key}`)),
          h('option', { value: 'new' }, 'Добавить как новую'),
          h('option', { value: 'skip' }, 'Пропустить')]
        : r.dupOf != null
          ? [h('option', { value: '' }, '— выберите —'), h('option', { value: 'new' }, 'Добавить как отдельную'), h('option', { value: 'skip' }, 'Пропустить')]
          : [h('option', { value: 'new' }, 'Добавить'), h('option', { value: 'skip' }, 'Пропустить')];
      const sel = h('select' + (needsDecision(r) && !dec ? '.need' : ''), {
        onchange: (e) => {
          const v = e.target.value;
          st.decisions[r.i] = !v ? null : v.startsWith('merge:') ? { action: 'merge', target: Number(v.slice(6)) } : { action: v };
          draw();
        },
      }, opts);
      sel.value = !dec ? '' : dec.action === 'merge' ? 'merge:' + dec.target : dec.action;
      action = sel;
    }

    return h('tr' + (r.errors.length ? '.row-err' : needsDecision(r) && !dec ? '.row-need' : ''),
      h('td.muted', r.excelRow),
      h('td', { style: { whiteSpace: 'normal', maxWidth: '360px' } },
        h('strong', headline), r.type ? h('span.muted.small', '  ' + r.type) : null,
        rest.length ? h('div.small.muted', rest.map((v) => `${v.label}: ${v.value}`).join(' · ')) : null),
      h('td', { style: { whiteSpace: 'normal' } }, check, notes),
      h('td', action));
  }

  // ======================= Шаг 4. Готово =======================
  function stepDone() {
    const R = st.result;
    const list = (title, items) => items.length ? h('div.section',
      h('h3', title),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        items.slice(0, 300).map((x) => h('a.chip-link', { href: `#/devices/${x.id}` }, x.key, x.title ? h('span.muted', ' ' + x.title) : null)),
        items.length > 300 ? h('span.muted', `и ещё ${items.length - 300}`) : null)) : null;
    return h('div',
      h('div.import-stats',
        stat(R.created.length, 'добавлено', 'новой техники'),
        stat(R.merged.length, 'объединено', 'с существующей техникой'),
        stat(R.skipped, 'пропущено', 'строк'),
        R.failed.length ? stat(R.failed.length, 'с ошибками', 'не загружены', 'err') : null),
      list('Добавленная техника', R.created),
      list('Обновлённая техника', R.merged.map((m) => ({ ...m, title: m.changed ? `изменено полей: ${m.changed}` : 'без изменений' }))),
      R.failed.length ? h('div.section', h('h3', 'Не загружены'),
        R.failed.map((f) => h('div.small', `Строка ${st.headerRow + f.row + 2}: `, f.errors.join('; ')))) : null,
      h('p.muted', 'В истории каждого устройства записано, из какого файла оно добавлено или обновлено.'),
      h('div.wizard-foot',
        h('a.btn', { href: '#/devices' }, 'К списку техники'),
        h('span.spacer'),
        h('button.btn.primary', { onclick: () => { Object.assign(st, { sheets: [], preview: null, result: null }); go(0); } }, 'Импортировать ещё файл')));
  }

  draw();
}

/** Строке нужно решение редактора: найдена такая же техника в базе или строка повторяет другую строку файла */
const needsDecision = (r) => r.matches.length > 0 || r.dupOf != null;

function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return 'Колонка ' + s;
}

