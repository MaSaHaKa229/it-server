// Настройки → «Формат данных из сети»: шаблоны значений для карточки и замены «из сети → как в базе»
import { h, clear, api, toast, run, confirmDialog } from '../ui.js';

export async function renderNetFormat(box) {
  const data = await api.get('/api/netinfo/formats');
  const inputs = {};
  const examples = {};
  let timer = null;

  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const formats = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      try {
        const { preview: p } = await api.post('/api/netinfo/formats/preview', { formats });
        for (const k of Object.keys(examples)) examples[k].textContent = p[k] || '— (пусто)';
      } catch { /* пример не обновился — не страшно */ }
    }, 250);
  };

  const rows = Object.entries(data.fields).map(([k, label]) => {
    const inp = h('input', { type: 'text', value: data.formats[k] || '' });
    inp.addEventListener('input', preview);
    inputs[k] = inp;
    examples[k] = h('b', data.preview[k] || '—');
    const chips = Object.entries(data.vars[k] || {}).map(([v, hint]) => h('button.nf-var', {
      type: 'button', title: hint,
      onclick: () => {
        const pos = inp.selectionStart ?? inp.value.length;
        inp.value = inp.value.slice(0, pos) + `{${v}}` + inp.value.slice(inp.selectionEnd ?? pos);
        inp.focus(); preview();
      },
    }, `{${v}}`));
    return h('div.nf-row',
      h('div.nf-label', label),
      h('div.nf-main', inp, h('div.nf-vars', chips),
        h('div.small.muted', 'Пример: ', examples[k],
          h('a', { href: '#', style: { marginLeft: '10px' }, onclick: (e) => { e.preventDefault(); inp.value = data.defaults[k]; preview(); } }, 'как было'))));
  });

  const save = h('button.btn.primary', 'Сохранить шаблоны');
  save.addEventListener('click', () => run(async () => {
    await api.put('/api/netinfo/formats', { formats: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) });
    toast('Шаблоны сохранены — они применяются в «Сведениях из сети» и при сканировании');
  }, save));

  // ---------- Замены ----------
  const FIELD_LABELS = { ...data.fields, serial_number: 'Серийный №' };
  const field = h('select', Object.entries(FIELD_LABELS).map(([k, l]) => h('option', { value: k }, l)));
  const src = h('input', { type: 'text', placeholder: 'Как приходит из сети, например: Intel Core i5-12400' });
  const dst = h('input', { type: 'text', placeholder: 'Как записано у вас, например: i5-12400 / 2.5 GHz' });
  const add = h('button.btn', 'Добавить замену');
  add.addEventListener('click', () => run(async () => {
    await api.post('/api/netinfo/replacements', { field: field.value, src: src.value, dst: dst.value });
    toast('Замена добавлена');
    renderNetFormat(box);
  }, add));

  clear(box,
    h('div.page-head', h('h2', 'Формат данных из сети')),
    h('p.muted', { style: { marginTop: '-8px', maxWidth: '900px' } },
      'Как записывать в карточку то, что приходит из WMI, SNMP и сети, — чтобы значения совпадали с вашими справочниками. ',
      'Шаблон — текст с переменными в фигурных скобках: нажмите на переменную, чтобы вставить её. ',
      'Применяется в «Сведениях из сети», при сравнении с карточкой и при добавлении техники со «Сканирования сети».'),
    h('div.np-box', rows, h('div', { style: { marginTop: '12px' } }, save)),
    h('div.np-box',
      h('h3', 'Замены'),
      h('p.hint', 'Если после шаблона значение всё равно не такое, как у вас, — укажите точную замену. ',
        'Замены добавляются и прямо из окна «Сравнение с карточкой»: исправьте значение и отметьте «запомнить».'),
      h('div.nf-add', field, src, h('span', '→'), dst, add),
      data.replacements.length ? h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', 'Поле'), h('th', 'Из сети'), h('th', ''), h('th', 'В базе'), h('th', ''))),
        h('tbody', data.replacements.map((r) => h('tr',
          h('td', FIELD_LABELS[r.field] || r.field), h('td', r.src), h('td.muted', '→'), h('td', h('b', r.dst)),
          h('td', { style: { textAlign: 'right' } }, h('button.btn.sm.subtle', {
            onclick: async () => {
              if (!await confirmDialog({ title: 'Удалить замену?', text: `«${r.src}» → «${r.dst}»` })) return;
              run(async () => { await api.del('/api/netinfo/replacements/' + r.id); renderNetFormat(box); });
            },
          }, 'Удалить')))))))
        : h('p.muted', 'Замен пока нет.')));
}
