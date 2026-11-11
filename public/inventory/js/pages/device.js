// Карточка устройства — по образцу страницы задачи в Jira
import {
  h, clear, icon, api, toast, run, modal, menu, confirmDialog, combobox, typeDot, deviceKey,
  avatar, fmtDate, timeAgo, statusInfo, solidColors,
} from '../ui.js';
import {
  state, isStaff, typeById, coreFieldsForType, customDesc, displayValue, fieldEditor,
  softwareItems, invalidateSoftware, softwareFields,
} from '../store.js';
import { navigate } from '../app.js';
import { openFieldModal } from './settings.js';

let activeTab = 'software';

export async function renderDevice(root, id) {
  const P = state.perms;
  const staff = isStaff();
  let data;

  async function reload() {
    data = await api.get('/api/devices/' + id);
    render();
  }
  const changed = async () => { await reload(); window.dispatchEvent(new Event('itdb:changed')); };

  async function patch(body) {
    await api.patch('/api/devices/' + id, body);
    await changed();
  }

  // ---------- Инлайн-редактирование ----------
  function editable(desc, { block = false, multiline = false } = {}) {
    const box = h('div');
    const dev = data.device;
    const show = () => {
      const v = displayValue(desc, dev);
      clear(box, h('div.editable' + (staff ? '' : '.readonly') + (multiline ? '.pre' : ''),
        { onclick: staff ? edit : null, title: staff ? 'Нажмите, чтобы изменить' : null },
        v !== '' && v != null ? String(v) : h('span.ph', staff ? (multiline ? 'Добавить…' : 'Не указано') : '—')));
    };
    const edit = () => {
      const ed = fieldEditor(desc, dev, { autofocus: true });
      const saveBtn = h('button.btn' + (block ? '.primary' : ''), { title: 'Сохранить', type: 'button' }, block ? 'Сохранить' : icon('check'));
      const cancelBtn = h('button.btn', { title: 'Отмена', type: 'button' }, block ? 'Отмена' : icon('close'));
      const save = () => run(async () => { await patch(ed.patch()); toast(`«${desc.label}» сохранено`); }, saveBtn);
      saveBtn.addEventListener('click', save);
      cancelBtn.addEventListener('click', show);
      const wrap = h('div.inline-editor' + (block ? '.block' : ''), ed.el, h('div.ie-actions', saveBtn, cancelBtn));
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.querySelector('.popover')) { e.preventDefault(); show(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (e.target.tagName !== 'TEXTAREA' && !e.defaultPrevented))) {
          if (e.target.tagName === 'SELECT') return;
          e.preventDefault(); save();
        }
      });
      clear(box, wrap);
      if (!block) box.style.marginBottom = '38px';
      const onDone = () => { box.style.marginBottom = ''; };
      cancelBtn.addEventListener('click', onDone);
    };
    show();
    return box;
  }

  let showAllChars = false;

  // Тип техники — выбор из списка
  function typeEditable(type) {
    const box = h('div');
    const show = () => clear(box, h('div.editable' + (staff ? '' : '.readonly'),
      { onclick: staff ? edit : null, title: staff ? 'Нажмите, чтобы изменить' : null },
      h('span.type-cell', typeDot(type), type.name)));
    const edit = () => {
      const sel = h('select', state.meta.types.map((t) => h('option', { value: t.id, selected: t.id === data.device.type_id }, t.name)));
      const saveBtn = h('button.btn', { title: 'Сохранить', type: 'button' }, icon('check'));
      const cancelBtn = h('button.btn', { title: 'Отмена', type: 'button' }, icon('close'));
      saveBtn.addEventListener('click', () => run(async () => {
        if (Number(sel.value) !== data.device.type_id) { await patch({ type_id: Number(sel.value) }); toast('Тип изменён'); } else show();
      }, saveBtn));
      cancelBtn.addEventListener('click', () => { box.style.marginBottom = ''; show(); });
      clear(box, h('div.inline-editor', sel, h('div.ie-actions', saveBtn, cancelBtn)));
      box.style.marginBottom = '38px';
      sel.focus();
    };
    show();
    return box;
  }

  // ---------- Рендер ----------
  function render() {
    const d = data.device;
    const type = typeById(d.type_id) || { name: d.type_name, code: d.type_code, color: d.type_color, fields: [] };
    const key = deviceKey(d);
    document.title = `${key} ${d.hostname || ''} — ИТ Инвентарь`;

    // Все характеристики выводятся справа. Сначала — поля, включённые для типа техники,
    // затем остальные базовые поля: заполненные видны всегда, пустые — по кнопке «Показать все поля».
    const notesDesc = state.meta.coreFields.find((f) => f.key === 'notes');
    const typeKeys = new Set(coreFieldsForType(d.type_id, { withText: true }).map((f) => f.key));
    const allChars = state.meta.coreFields.filter((f) => f.key !== 'notes');
    const hasValue = (f) => displayValue(f, d) !== '' && displayValue(f, d) != null;
    const mainChars = allChars.filter((f) => typeKeys.has(f.key) || hasValue(f));
    const restChars = allChars.filter((f) => !mainChars.includes(f));

    // Кнопка состояния (как статус задачи в Jira)
    const stInfo = statusInfo(d.status);
    const statusBtn = h('button.btn.status-btn', { style: solidColors(stInfo.color) }, stInfo.label, staff ? icon('chevron') : null);
    if (staff) statusBtn.addEventListener('click', () => menu(statusBtn, state.meta.statuses
      .filter((s) => s.key !== d.status)
      .map((s) => ({ label: s.label, onClick: () => run(async () => { await patch({ status: s.key }); toast(`Состояние: ${s.label}`); }) }))));
    else statusBtn.disabled = true;

    const moreBtn = staff ? h('button.btn.icon', { title: 'Действия' }, icon('more')) : null;
    moreBtn && moreBtn.addEventListener('click', () => menu(moreBtn, [
      { label: 'Добавить поле', icon: 'plus', onClick: addField },
      { label: 'Создать копию', icon: 'copy', onClick: cloneDevice },
      '-',
      { label: 'Удалить устройство', icon: 'trash', danger: true, onClick: deleteDevice },
    ], { align: 'right' }));

    // Заголовок — только для чтения; сетевое имя и модель редактируются в панели справа
    const title = h('h1.issue-title', d.hostname || d.model || `${type.name} ${key}`);

    // ----- левая колонка -----
    const left = h('div',
      h('div.row', { style: { alignItems: 'flex-start' } }, h('div.grow', title), statusBtn, moreBtn),
      h('div.issue-actions',
        staff && P.software ? h('button.btn', { onclick: () => softwareModal() }, icon('plus'), 'Добавить ПО') : null,
        staff ? h('button.btn', { onclick: () => credentialModal() }, icon('lock'), 'Добавить пароль') : null,
        staff ? h('button.btn', { onclick: addField }, icon('plus'), 'Добавить поле') : null),
      notesDesc ? h('div.section', h('h3', 'Описание'), editable(notesDesc, { block: true, multiline: true })) : null,
      renderTabs());

    // ----- правая колонка -----
    const customs = data.fields.map(customDesc);
    const charRow = (f) => {
      const multi = f.kind === 'textarea';
      // Длинный текст — на всю ширину панели, подпись сверху
      return multi
        ? h('div.drow.wide', h('div.dl', f.label), h('div.dv', editable(f, { block: true, multiline: true })))
        : h('div.drow', h('div.dl', f.label), h('div.dv', editable(f)));
    };
    const detailRows = [
      ...mainChars.map(charRow),
      ...(showAllChars ? restChars.map(charRow) : []),
      restChars.length ? h('button.btn.link.small', {
        style: { marginTop: '6px' },
        onclick: () => { showAllChars = !showAllChars; render(); },
      }, showAllChars ? 'Скрыть поля, не используемые для этого типа' : `Показать все поля (+${restChars.length})`) : null,
    ];
    const right = h('div',
      h('div.details',
        h('div.d-head', 'Сведения'),
        h('div.d-body',
          h('div.drow', h('div.dl', 'Тип'), h('div.dv', typeEditable(type))),
          h('div.drow', h('div.dl', 'Рабочее место'), h('div.dv', h('div.editable.readonly',
            d.workplace_id ? h('a', { href: '#/workplaces/' + d.workplace_id }, d.workplace)
              : h('span.ph', 'не привязано — см. «Рабочие места»')))),
          detailRows)),
      h('div.details', { style: { marginTop: '16px' } },
        h('div.d-head', 'Дополнительные поля', h('span.spacer'),
          staff ? h('button.btn.subtle.sm', { onclick: addField }, icon('plus', 14), 'Поле') : null),
        h('div.d-body', customs.length ? customs.map((f) => h('div.drow',
          h('div.dl', f.label,
            f.scope === 'device' ? h('span.scope-tag', 'только это устройство',
              staff ? h('a', { href: '#', style: { marginLeft: '6px' }, onclick: (e) => { e.preventDefault(); removeInstanceField(f); } }, 'удалить') : null)
              : f.scope === 'type' ? h('span.scope-tag', 'для типа ' + type.name) : null),
          h('div.dv', editable(f, { multiline: f.kind === 'textarea', block: f.kind === 'textarea' }))))
          : h('p.muted.small', { style: { margin: '8px 0' } }, 'Дополнительных полей нет'))),
      h('div.dates',
        h('div', 'Создано ', fmtDate(d.created_at)),
        h('div', 'Изменено ', fmtDate(d.updated_at))));

    clear(root,
      h('div.breadcrumbs',
        h('a', { href: '#/' }, 'ИТ-служба'), h('span.sep', '/'),
        h('a', { href: '#/devices' }, 'Техника'), h('span.sep', '/'),
        h('a', { href: `#/devices?f=${encodeURIComponent(JSON.stringify({ type: [d.type_id] }))}` }, type.name), h('span.sep', '/'),
        h('span.row', { style: { gap: '4px' } }, typeDot(type), h('a', { href: `#/devices/${d.id}` }, key))),
      h('div.issue', left, right));
  }

  // ---------- Вкладки ----------
  function renderTabs() {
    const tabs = [];
    if (P.software) tabs.push(['software', `Установленное ПО (${data.software.length})`, renderSoftware]);
    if (P.passwords) tabs.push(['passwords', `Пароли (${data.credentials.length})`, renderCredentials]);
    if (P.history) tabs.push(['history', 'История', renderHistory]);
    if (!tabs.length) return null;
    if (!tabs.find((t) => t[0] === activeTab)) activeTab = tabs[0][0];
    const body = h('div');
    const bar = h('div.tabs', tabs.map(([k, label]) => h('button.tab' + (k === activeTab ? '.active' : ''), {
      onclick: () => { activeTab = k; bar.querySelectorAll('.tab').forEach((b, i) => b.classList.toggle('active', tabs[i][0] === k)); clear(body, tabs.find((t) => t[0] === k)[2]()); },
    }, label)));
    clear(body, tabs.find((t) => t[0] === activeTab)[2]());
    return h('div.section', h('h3', 'Активность'), bar, body);
  }

  function renderSoftware() {
    const rows = data.software;
    if (!rows.length) {
      return h('div.empty-state', { style: { padding: '24px' } },
        h('p', 'На устройстве пока не указано ПО'),
        staff ? h('button.btn', { onclick: () => softwareModal() }, icon('plus'), 'Добавить ПО') : null);
    }
    const instF = softwareFields('install');
    const swF = softwareFields('software');
    // Поля программы из справочника — мелким текстом под названием
    const swInfo = (s) => swF.map((f) => {
      const v = displayValue(f, { extra: s.software_extra });
      return v !== '' ? h('div.muted.small', `${f.label}: ${v}`) : null;
    });
    const table = h('div.table-wrap', { style: { borderTop: 0 } }, h('table.list',
      h('thead', h('tr', h('th', 'Программа'), h('th', 'Версия'), h('th', 'Лицензия'), h('th', 'Установлено'),
        instF.map((f) => h('th', f.label)), h('th', 'Примечание'), staff ? h('th', '') : null)),
      h('tbody', rows.map((s) => h('tr',
        h('td', { style: { whiteSpace: 'normal' } }, h('strong', s.name), s.vendor ? h('div.muted.small', s.vendor) : null, swInfo(s)),
        h('td', s.version || ''),
        h('td.mono', { title: s.license_key || '' }, s.license_key || ''),
        h('td.nowrap', s.installed_at ? fmtDate(s.installed_at, false) : ''),
        instF.map((f) => { const v = displayValue(f, { extra: s.extra }); return h('td', { title: String(v) }, v); }),
        h('td', { title: s.note || '' }, s.note || ''),
        staff ? h('td.nowrap', { style: { textAlign: 'right' } },
          h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => softwareModal(s) }, icon('edit', 14)),
          h('button.btn.subtle.sm.icon', {
            title: 'Удалить',
            onclick: async () => {
              if (!await confirmDialog({ title: 'Удалить ПО?', text: `«${s.name}» будет удалено из списка ПО этого устройства.` })) return;
              run(async () => { await api.del(`/api/devices/${id}/software/${s.id}`); toast('ПО удалено'); await changed(); });
            },
          }, icon('trash', 14))) : null)))));
    return h('div', table, staff ? h('div', { style: { marginTop: '8px' } },
      h('a.small', { href: '#/settings/fields' }, 'Настроить дополнительные поля ПО')) : null);
  }

  function renderCredentials() {
    const rows = data.credentials;
    if (!rows.length) {
      return h('div.empty-state', { style: { padding: '24px' } }, h('p', 'Пароли не добавлены'),
        staff ? h('button.btn', { onclick: () => credentialModal() }, icon('plus'), 'Добавить пароль') : null);
    }
    return h('div.table-wrap', { style: { borderTop: 0 } }, h('table.list',
      h('thead', h('tr', h('th', 'Назначение'), h('th', 'Логин'), h('th', 'Пароль'), h('th', 'Примечание'), h('th', 'Изменён'), staff ? h('th', '') : null)),
      h('tbody', rows.map((c) => {
        const secretEl = h('span.secret', '••••••••');
        let shown = null;
        const reveal = async () => {
          if (shown) { secretEl.textContent = '••••••••'; shown = null; return; }
          const r = await run(() => api.get(`/api/devices/${id}/credentials/${c.id}/secret`));
          if (!r) return;
          shown = r.secret; secretEl.textContent = r.secret;
          setTimeout(() => { if (shown) { secretEl.textContent = '••••••••'; shown = null; } }, 30000);
        };
        const copy = async () => {
          const r = shown ? { secret: shown } : await run(() => api.get(`/api/devices/${id}/credentials/${c.id}/secret`));
          if (!r) return;
          try { await navigator.clipboard.writeText(r.secret); toast('Пароль скопирован'); } catch { toast('Не удалось скопировать', 'err'); }
        };
        return h('tr',
          h('td', h('strong', c.title)),
          h('td.mono', c.login || ''),
          h('td.nowrap', secretEl,
            h('button.btn.subtle.sm.icon', { title: 'Показать / скрыть', onclick: reveal }, icon('eye', 14)),
            h('button.btn.subtle.sm.icon', { title: 'Копировать', onclick: copy }, icon('copy', 14))),
          h('td', { title: c.note || '' }, c.note || ''),
          h('td.muted.small.nowrap', fmtDate(c.updated_at), c.updated_by ? ' · ' + c.updated_by : ''),
          staff ? h('td.nowrap', { style: { textAlign: 'right' } },
            h('button.btn.subtle.sm.icon', { title: 'Изменить', onclick: () => credentialModal(c) }, icon('edit', 14)),
            h('button.btn.subtle.sm.icon', {
              title: 'Удалить',
              onclick: async () => {
                if (!await confirmDialog({ title: 'Удалить пароль?', text: `Запись «${c.title}» будет удалена.` })) return;
                run(async () => { await api.del(`/api/devices/${id}/credentials/${c.id}`); toast('Пароль удалён'); await changed(); });
              },
            }, icon('trash', 14))) : null);
      }))));
  }

  const ACTIONS = {
    created: 'добавил(а) устройство', updated: 'изменил(а) данные', software_added: 'добавил(а) ПО',
    software_updated: 'изменил(а) ПО', software_removed: 'удалил(а) ПО', password_added: 'добавил(а) пароль',
    password_updated: 'изменил(а) пароль', password_removed: 'удалил(а) пароль', password_viewed: 'просмотрел(а) пароль',
  };
  function renderHistory() {
    if (!data.history.length) return h('p.muted', 'Нет записей');
    return h('div', data.history.map((e) => {
      const who = e.full_name || e.username || 'Удалённый пользователь';
      const changes = Object.entries(e.changes || {});
      return h('div.activity', avatar(who, 'sm'),
        h('div.body',
          h('div', h('span.who', who), ' ', ACTIONS[e.action] || e.action, ' ',
            h('span.muted.small', { title: fmtDate(e.created_at) }, timeAgo(e.created_at))),
          changes.length ? h('div.chg', changes.map(([field, [a, b]]) => h('div',
            h('span.muted', field + ': '),
            a != null && a !== '' ? h('span.old', String(a)) : null,
            a != null && a !== '' && b != null && b !== '' ? h('span.arr', '→') : null,
            b != null && b !== '' ? h('span', String(b)) : null))) : null));
    }));
  }

  // ---------- Модальные окна ----------
  function softwareModal(row) {
    const instF = softwareFields('install');
    const swF = softwareFields('software');
    let program = row ? { id: row.software_id, label: row.name, vendor: row.vendor, extra: row.software_extra || {} } : null;

    // Поля программы (общие для всех устройств) — перерисовываются при выборе программы
    const swBox = h('div.form-grid.wide');
    let swEditors = [];
    const drawSw = () => {
      swEditors = [];
      if (!swF.length) { clear(swBox); return; }
      if (!program) {
        clear(swBox, h('p.hint.wide', 'Выберите программу, чтобы заполнить сведения о ней'));
        return;
      }
      const dev = { extra: { ...(program.extra || {}) } };
      clear(swBox, swF.map((f) => {
        const ed = fieldEditor(f, dev);
        swEditors.push(ed);
        return h('label.field' + (f.kind === 'textarea' ? '.wide' : ''), h('span', f.label), ed.el);
      }));
    };

    const cb = combobox({
      value: program,
      placeholder: 'Начните вводить название…',
      load: softwareItems,
      create: async (text) => {
        const r = await api.post('/api/software', { name: text });
        invalidateSoftware();
        return { id: r.id, label: r.name, vendor: null, extra: {} };
      },
      onChange: (v) => { program = v; drawSw(); },
      autofocus: !row,
    });
    const version = h('input', { type: 'text', value: row?.version || '' });
    const lic = h('input', { type: 'text', value: row?.license_key || '' });
    const date = h('input', { type: 'date', value: row?.installed_at ? String(row.installed_at).slice(0, 10) : '' });
    const note = h('input', { type: 'text', value: row?.note || '' });

    // Поля установки (своё значение на этом устройстве)
    const instDev = { extra: { ...(row?.extra || {}) } };
    const instEditors = instF.map((f) => ({ f, ed: fieldEditor(f, instDev) }));
    drawSw();

    const collect = (eds) => Object.assign({}, ...eds.map((ed) => ed.patch().extra));

    const save = h('button.btn.primary', {
      onclick: () => run(async () => {
        const sw = cb.get();
        if (!sw) throw new Error('Выберите программу');
        // Сведения о программе изменились — обновляем справочник (это видно на всех устройствах)
        if (swEditors.length) {
          const next = collect(swEditors);
          const before = program?.extra || {};
          const changedSw = Object.keys(next).some((k) => String(next[k] ?? '') !== String(before[k] ?? ''));
          if (changedSw) {
            await api.put('/api/software/' + sw.id, { name: sw.label, vendor: program?.vendor ?? sw.vendor ?? '', extra: { ...before, ...next } });
            invalidateSoftware();
          }
        }
        const body = {
          software_id: sw.id, version: version.value, license_key: lic.value, installed_at: date.value, note: note.value,
          extra: collect(instEditors.map((x) => x.ed)),
        };
        if (row) await api.put(`/api/devices/${id}/software/${row.id}`, body);
        else await api.post(`/api/devices/${id}/software`, body);
        m.close(); toast(row ? 'ПО обновлено' : 'ПО добавлено');
        activeTab = 'software';
        await changed();
      }, save),
    }, row ? 'Сохранить' : 'Добавить');

    const m = modal({
      title: row ? 'Изменить ПО' : 'Добавить ПО', size: 'wide',
      body: h('div.form-grid',
        h('div.field.wide', h('span.field-label', 'Программа ', h('span.req', '*')), cb.el,
          h('div.hint', 'Выберите из справочника ПО или введите новое название и нажмите «Добавить»')),
        h('label.field', h('span', 'Версия'), version),
        h('label.field', h('span', 'Дата установки'), date),
        h('label.field.wide', h('span', 'Лицензионный ключ'), lic),
        instEditors.map(({ f, ed }) => h('label.field' + (f.kind === 'textarea' ? '.wide' : ''), h('span', f.label), ed.el)),
        h('label.field.wide', h('span', 'Примечание'), note),
        swF.length ? h('div.wide', { style: { borderTop: '1px solid var(--n30)', paddingTop: '12px' } },
          h('h4', 'Сведения о программе'),
          h('div.hint', { style: { marginBottom: '8px' } }, 'Общие для всех устройств, где установлена эта программа')) : null,
        swF.length ? swBox : null),
      footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
    });
  }


  function credentialModal(row) {
    const title = h('input', { type: 'text', value: row?.title || '', placeholder: 'Локальный администратор, BIOS, веб-интерфейс…' });
    const login = h('input', { type: 'text', value: row?.login || '', autocomplete: 'off' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: row ? 'Оставьте пустым, чтобы не менять' : '' });
    const note = h('input', { type: 'text', value: row?.note || '' });
    const toggle = h('button.btn.icon', { type: 'button', title: 'Показать', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; } }, icon('eye'));
    const gen = h('button.btn', { type: 'button', title: 'Сгенерировать', onclick: () => { pass.value = genPassword(); pass.type = 'text'; } }, 'Сгенерировать');
    const save = h('button.btn.primary', {
      onclick: () => run(async () => {
        const body = { title: title.value, login: login.value, password: pass.value, note: note.value };
        if (row) await api.put(`/api/devices/${id}/credentials/${row.id}`, body);
        else await api.post(`/api/devices/${id}/credentials`, body);
        m.close(); toast(row ? 'Пароль обновлён' : 'Пароль добавлен');
        activeTab = 'passwords';
        await changed();
      }, save),
    }, row ? 'Сохранить' : 'Добавить');
    const m = modal({
      title: row ? 'Изменить пароль' : 'Добавить пароль',
      body: h('div.form-grid',
        h('label.field.wide', h('span', 'Назначение ', h('span.req', '*')), title),
        h('label.field', h('span', 'Логин'), login),
        h('div.field', h('span.field-label', 'Пароль', row ? '' : h('span.req', ' *')), h('div.row', pass, toggle, gen)),
        h('label.field.wide', h('span', 'Примечание'), note),
        h('p.hint.wide', 'Пароли хранятся в базе в зашифрованном виде (AES-256-GCM). Каждый просмотр пароля записывается в историю.')),
      footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
    });
  }

  function addField() {
    const d = data.device;
    openFieldModal({
      device: d,
      onSaved: async () => { const { loadMeta } = await import('../store.js'); await loadMeta(); await reload(); },
    });
  }

  async function removeInstanceField(f) {
    if (!await confirmDialog({ title: 'Удалить поле?', text: `Поле «${f.label}» и его значение будут удалены у этого устройства.` })) return;
    run(async () => { await api.del('/api/fields/' + f.id); toast('Поле удалено'); await reload(); });
  }

  async function cloneDevice() {
    await run(async () => {
      const r = await api.post(`/api/devices/${id}/clone`);
      toast('Создана копия (без сетевого имени, серийного номера, IP и паролей)');
      window.dispatchEvent(new Event('itdb:changed'));
      navigate('/devices/' + r.id);
    });
  }

  async function deleteDevice() {
    const d = data.device;
    if (!await confirmDialog({ title: `Удалить ${deviceKey(d)}?`, text: 'Устройство будет удалено вместе с ПО, паролями и историей. Если техника выведена из эксплуатации, лучше поставьте состояние «Списано».' })) return;
    await run(async () => {
      await api.del('/api/devices/' + id);
      toast(`${deviceKey(d)} удалено`);
      window.dispatchEvent(new Event('itdb:changed'));
      navigate('/devices');
    });
  }

  try {
    await reload();
  } catch (e) {
    clear(root, h('div.empty-state', h('h3', 'Устройство не найдено'), h('p', e.message), h('a', { href: '#/devices' }, 'К списку техники')));
  }
}

function genPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return [...a].map((x) => chars[x % chars.length]).join('');
}

