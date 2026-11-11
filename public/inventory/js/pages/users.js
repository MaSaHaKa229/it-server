// Пользователи и права доступа (только суперадмин)
import { h, clear, icon, api, toast, run, modal, avatar, fmtDate } from '../ui.js';
import { state, lookupItems } from '../store.js';
import { ROLE_LABEL } from '../app.js';

const ROLE_DESC = {
  superadmin: 'Полный доступ: учётные записи, роли, права, все данные',
  editor: 'Добавление и изменение техники, справочников и полей, выгрузка в Excel',
  reader: 'Просмотр только разрешённой информации, выборки и выгрузка',
};

export async function renderUsers(root) {
  document.title = 'Пользователи — ИТ Инвентарь';
  const users = await api.get('/api/users');
  const reload = () => renderUsers(root);
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('span', 'Пользователи')),
    h('div.page-head', h('h1', 'Пользователи'), h('span.badge', users.length), h('span.spacer'),
      h('a.btn', { href: '/admin' }, icon('cog'), 'Учётные записи — в администрировании портала')),
    h('p.hint', { style: { marginBottom: '12px' } },
      'Здесь показаны пользователи, которым открыт ИТ-инвентарь. Учётные записи, пароли и доступ к остальным разделам ',
      'настраиваются на главной странице портала → «Администрирование». Здесь задаётся роль в инвентаре и что именно видит читатель.'),
    h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Пользователь'), h('th', 'Логин'), h('th', 'Роль'), h('th', 'Доступ'), h('th', 'Последний вход'), h('th', 'Статус'), h('th', ''))),
      h('tbody', users.map((u) => h('tr' + (u.role === 'superadmin' ? '' : '.clickable'), { onclick: (e) => { if (u.role !== 'superadmin' && !e.target.closest('button')) userModal(u, reload); } },
        h('td', h('span.row', avatar(u.full_name || u.username, 'sm'), u.full_name || h('span.muted', '—'))),
        h('td.mono', u.username),
        h('td', h('span.lozenge' + (u.role === 'superadmin' ? '.purple' : u.role === 'editor' ? '.blue' : ''), ROLE_LABEL[u.role])),
        h('td.muted.small', accessSummary(u)),
        h('td.muted.small', u.last_login ? fmtDate(u.last_login) : 'никогда'),
        h('td', u.is_active ? h('span.lozenge.green', 'Активен') : h('span.lozenge.red', 'Отключён')),
        h('td.nowrap', { style: { textAlign: 'right' } },
          u.role === 'superadmin' ? h('span.muted.small', 'администратор портала') : h('span.muted.small', 'настроить →'))))))));
}

function accessSummary(u) {
  if (u.role !== 'reader') return 'Полный';
  const p = u.permissions || {};
  const parts = [];
  parts.push(p.types === null ? 'все типы' : `типов: ${(p.types || []).length}`);
  if (Array.isArray(p.departments)) parts.push(`отделов: ${p.departments.length}`);
  if (Array.isArray(p.fields)) parts.push(`полей: ${p.fields.length}`);
  if (p.passwords) parts.push('пароли');
  if (p.software) parts.push('ПО');
  if (p.export === false) parts.push('без выгрузки');
  return parts.join(', ');
}

async function userModal(u, done) {
  const p = u?.permissions || {};
  let role = u?.role || 'reader';

  // ---------- права читателя ----------
  const departments = await lookupItems('department').catch(() => []);
  const permsBox = h('div');

  /** Группа чекбоксов с переключателем «все» */
  function checkGroup(title, items, selected, allLabel) {
    const all = h('input', { type: 'checkbox', checked: selected === null });
    const sel = new Set((selected || []).map(String));
    const boxes = items.map((it) => h('label.check', h('input', {
      type: 'checkbox', value: it.id, checked: selected === null || sel.has(String(it.id)), disabled: selected === null,
    }), it.label));
    const list = h('div.perm-list', boxes);
    all.addEventListener('change', () => boxes.forEach((b) => { const i = b.querySelector('input'); i.disabled = all.checked; if (all.checked) i.checked = true; }));
    return {
      el: h('div.perm-box', h('div.row', h('strong', title), h('span.spacer'), h('label.check.small', all, allLabel)), items.length ? list : h('p.muted.small', 'Нет значений')),
      get: () => (all.checked ? null : boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value)),
    };
  }

  const gTypes = checkGroup('Типы техники', state.meta.types.map((t) => ({ id: t.id, label: t.name })), p.types === null ? null : (p.types || []), 'Все типы');
  const gDepts = checkGroup('Отделы', departments, Array.isArray(p.departments) ? p.departments : null, 'Все отделы');
  const gFields = checkGroup('Видимые поля', state.meta.permissionFields.map((f) => ({ id: f.key, label: f.label })),
    Array.isArray(p.fields) ? p.fields : null, 'Все поля');
  const pw = h('input', { type: 'checkbox', checked: !!p.passwords });
  const sw = h('input', { type: 'checkbox', checked: !!p.software });
  const ex = h('input', { type: 'checkbox', checked: p.export !== false });

  clear(permsBox,
    h('h3', { style: { margin: '8px 0 4px' } }, 'Доступ читателя'),
    h('p.hint', { style: { marginBottom: '12px' } }, 'Читатель видит только отмеченное. Поиск, фильтры и выгрузка работают только по разрешённым данным.'),
    gTypes.el, gDepts.el, gFields.el,
    h('div.perm-box', h('strong', 'Дополнительно'),
      h('div.stack', { style: { marginTop: '8px' } },
        h('label.check', sw, 'Видеть установленное ПО'),
        h('label.check', pw, 'Видеть пароли устройств'),
        h('label.check', ex, 'Скачивать таблицы в Excel'))));

  const roleOpts = ['editor', 'reader'].map((r) => {
    const radio = h('input', { type: 'radio', name: 'role', value: r, checked: r === role });
    const el = h('label.role-opt' + (r === role ? '.on' : ''), radio, h('div', h('strong', ROLE_LABEL[r]), h('div.small.muted', ROLE_DESC[r])));
    radio.addEventListener('change', () => {
      role = r;
      document.querySelectorAll('.role-opt').forEach((x) => x.classList.toggle('on', x.querySelector('input').checked));
      permsBox.classList.toggle('hidden', role !== 'reader');
    });
    return el;
  });
  permsBox.classList.toggle('hidden', role !== 'reader');

  const save = h('button.btn.primary', {
    onclick: () => run(async () => {
      const body = {
        role,
        permissions: role === 'reader' ? {
          types: gTypes.get() === null ? null : gTypes.get().map(Number),
          departments: gDepts.get() === null ? null : gDepts.get().map(Number),
          fields: gFields.get(),
          passwords: pw.checked, software: sw.checked, export: ex.checked,
        } : {},
      };
      await api.put('/api/users/' + u.id, body);
      m.close(); toast('Изменения сохранены'); done();
    }, save),
  }, 'Сохранить');

  const m = modal({
    title: `Доступ к инвентарю: ${u.username}`, size: 'wide',
    body: h('div.stack', { style: { gap: '16px' } },
      h('div.row', avatar(u.full_name || u.username), h('div', h('strong', u.full_name || u.username), h('div.muted.small', u.username + (u.email ? ' · ' + u.email : '')))),
      h('div.field', h('span.field-label', 'Роль в ИТ-инвентаре'), h('div.stack', roleOpts)),
      permsBox),
    footer: [h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
}
