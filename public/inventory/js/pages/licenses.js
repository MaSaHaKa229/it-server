// Учёт лицензий ПО (можно скрыть: Настройки → «Возможности») и сбор установленного ПО с компьютера по WMI (не скрывается)
import { h, clear, api, toast, run, modal, combobox, typeDot, fmtDate, debounce, confirmDialog } from '../ui.js';
import { state, isStaff, isSuper, softwareItems, loadMeta } from '../store.js';

const day = (v) => (v ? String(v).slice(0, 10) : '');
const fmtDay = (v) => (v ? day(v).split('-').reverse().join('.') : '');

function licStyles() {
  if (document.getElementById('lic-style')) return;
  const st = document.createElement('style');
  st.id = 'lic-style';
  st.textContent = `
    .lic-bad { color: #DE350B; font-weight: 700; }
    .lic-ok { color: #006644; font-weight: 600; }
    .lic-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
    .lic-form .wide { grid-column: 1 / -1; }
    .sw-list { max-height: 52vh; overflow: auto; border: 1px solid var(--n40); border-radius: 3px; }
    .sw-list table { margin: 0; }
    .sw-sec td { background: var(--n20); font-weight: 600; }
  `;
  document.head.append(st);
}

// ===================== Лицензии =====================
function licenseDialog(lic, kinds, onDone) {
  let program = lic && lic.software_id ? { id: lic.software_id, label: lic.software_name } : null;
  const prog = combobox({ value: program, placeholder: 'Программа из справочника ПО…', load: softwareItems, onChange: (v) => { program = v; } });
  const match = h('input', { type: 'text', value: lic?.match || '', placeholder: 'Например: Microsoft Office' });
  const title = h('input', { type: 'text', value: lic?.title || '', placeholder: 'Например: Office 2019 для бухгалтерии (необязательно)' });
  const qty = h('input', { type: 'number', min: 0, value: lic?.qty ?? 1, style: { width: '120px' } });
  const kind = h('select', Object.entries(kinds).map(([k, l]) => h('option', { value: k, selected: (lic?.kind || 'device') === k }, l)));
  const purchased = h('input', { type: 'date', value: day(lic?.purchased) });
  const expires = h('input', { type: 'date', value: day(lic?.expires) });
  const contract = h('input', { type: 'text', value: lic?.contract || '', placeholder: 'Договор, счёт' });
  const key = h('textarea', { rows: 2, placeholder: 'Ключ или номер лицензии' }, lic?.license_key || '');
  const note = h('input', { type: 'text', value: lic?.note || '' });
  const save = h('button.btn.primary', lic ? 'Сохранить' : 'Добавить');
  const m = modal({
    title: lic ? 'Лицензия' : 'Новая лицензия',
    body: h('div.lic-form',
      h('label.field.wide', h('span', 'Программа'), prog.el),
      h('label.field', h('span', 'Шаблон названия'), match,
        h('div.hint', 'Считать все программы, в названии которых есть этот текст (разные версии)')),
      h('label.field', h('span', 'Название лицензии'), title),
      h('label.field', h('span', 'Куплено лицензий'), qty),
      h('label.field', h('span', 'Вид'), kind),
      h('label.field', h('span', 'Куплена'), purchased),
      h('label.field', h('span', 'Действует до'), expires, h('div.hint', 'Пусто — бессрочная')),
      h('label.field.wide', h('span', 'Договор'), contract),
      h('label.field.wide', h('span', 'Ключ'), key),
      h('label.field.wide', h('span', 'Примечание'), note)),
    footer: [
      lic ? h('button.btn.subtle', { style: { marginRight: 'auto' }, onclick: async () => {
        if (!await confirmDialog({ title: 'Удалить лицензию?', text: 'Сведения о покупке будут удалены. Установленное ПО в карточках не изменится.' })) return;
        run(async () => { await api.del(`/api/licenses/${lic.id}`); m.close(); toast('Удалено'); onDone(); });
      } }, 'Удалить') : null,
      h('button.btn.subtle', { onclick: () => m.close() }, 'Отмена'), save],
  });
  save.addEventListener('click', () => run(async () => {
    const b = { software_id: program ? program.id : null, match: match.value, title: title.value, qty: Number(qty.value), kind: kind.value,
      purchased: purchased.value, expires: expires.value, contract: contract.value, license_key: key.value, note: note.value };
    if (lic) await api.put(`/api/licenses/${lic.id}`, b); else await api.post('/api/licenses', b);
    m.close(); toast('Сохранено'); onDone();
  }, save));
}

function devicesDialog(lic) {
  const box = h('div', 'Загрузка…');
  const m = modal({ title: `Установки: ${lic.title || lic.software_name || lic.match}`, body: box, size: 'wide',
    footer: [h('button.btn', { onclick: () => m.close() }, 'Закрыть')] });
  run(async () => {
    const rows = await api.get(`/api/licenses/${lic.id}/devices`);
    clear(box, rows.length ? h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Техника'), h('th', 'Программа'), h('th', 'Версия'), h('th', 'Пользователь'), h('th', 'Расположение'))),
      h('tbody', rows.map((r) => h('tr',
        h('td', h('a', { href: `#/devices/${r.id}`, onclick: () => m.close() }, typeDot(r), ' ', `${r.type_code}-${r.id} ${r.hostname || ''}`)),
        h('td', r.software), h('td', r.version || ''), h('td', r.employee || ''), h('td', r.location || '')))))) : h('p.muted', 'Установок не найдено'));
  });
}

export async function renderLicenses(root) {
  licStyles();
  document.title = 'Лицензии ПО — ИТ Инвентарь';
  const staff = isStaff();
  const q = h('input', { type: 'search', placeholder: 'Программа, договор' });
  const box = h('div');
  let data;
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = data.items.filter((r) => !t || `${r.title} ${r.software_name} ${r.match} ${r.contract}`.toLowerCase().includes(t));
    const short = data.items.filter((r) => r.free != null && r.free < 0).length;
    clear(box,
      short ? h('div.error-box', { style: { marginBottom: '12px' } }, `Не хватает лицензий: ${short} поз.`) : null,
      h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', 'Программа'), h('th', 'Вид'), h('th', { style: { textAlign: 'right' } }, 'Куплено'),
          h('th', { style: { textAlign: 'right' } }, 'Установлено'), h('th', { style: { textAlign: 'right' } }, 'Свободно'), h('th', 'Действует до'), h('th', 'Договор'))),
        h('tbody', rows.length ? rows.map((r) => h('tr.clickable', { onclick: (e) => { if (!e.target.closest('a')) (staff ? licenseDialog(r, data.kinds, reload) : devicesDialog(r)); } },
          h('td', h('b', r.title || r.software_name || r.match), r.match ? h('div.small.muted', `все «${r.match}…»`) : r.title && r.software_name ? h('div.small.muted', r.software_name) : null),
          h('td.small', data.kinds[r.kind] || r.kind),
          h('td', { style: { textAlign: 'right' } }, r.kind === 'site' ? '∞' : r.qty),
          h('td', { style: { textAlign: 'right' } }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); devicesDialog(r); } }, String(r.used))),
          h('td', { style: { textAlign: 'right' } }, r.free == null ? '—' : h('span.' + (r.free < 0 ? 'lic-bad' : 'lic-ok'), r.free < 0 ? `не хватает ${-r.free}` : String(r.free))),
          h('td.nowrap', r.expires ? h('span' + (r.expired ? '.lic-bad' : ''), fmtDay(r.expires), r.expired ? ' (истекла)' : '') : h('span.muted', 'бессрочно')),
          h('td.small', r.contract || ''))) : h('tr.empty', h('td', { colspan: 7 }, data.items.length ? 'Ничего не найдено' : 'Лицензий пока нет'))))),
      h('p.muted.small', 'Установки считаются по ПО в карточках техники (списанная не считается). Чтобы данные были точными, ',
        'соберите ПО с компьютеров: карточка → «Добавить ▾» → «ПО с компьютера (WMI)».'));
  };
  const reload = async () => { data = await api.get('/api/licenses'); draw(); };
  q.addEventListener('input', debounce(draw, 200));
  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('span', 'Лицензии ПО')),
    h('div.page-head', h('h1', 'Лицензии ПО'), h('span.spacer'),
      h('a.btn', { href: '/inventory/api/licenses/export.xlsx' }, 'Excel'), ' ',
      staff ? h('button.btn.primary', { onclick: () => licenseDialog(null, data.kinds, reload) }, '+ Лицензия') : null),
    h('p.muted', { style: { marginTop: '-8px' } }, 'Сколько лицензий куплено и сколько установок найдено: видно нехватку и лишние.'),
    h('div.toolbar.row', h('div.search-box', { style: { width: '320px' } }, q)),
    box);
  await reload();
}

/** Настройки → «Возможности»: администратор портала скрывает учёт лицензий ото всех */
export async function renderFeatures(box) {
  const f = await api.get('/api/licenses/feature');
  const cb = h('input', { type: 'checkbox', checked: f.licenses !== false });
  clear(box, h('div.panel',
    h('h2', { style: { marginTop: 0 } }, 'Возможности'),
    h('label.check', cb, h('span', h('b', 'Учёт лицензий ПО'), h('span.muted', ' — раздел «Лицензии» в меню «Ещё»'))),
    h('p.hint', 'Если выключить, раздел скрывается у всех пользователей, включая администраторов. Сведения о лицензиях сохраняются — ',
      'при включении всё вернётся. Сбор установленного ПО с компьютеров (WMI) работает в любом случае.'),
    h('button.btn.primary', { onclick: (e) => run(async () => {
      await api.put('/api/licenses/feature', { licenses: cb.checked });
      await loadMeta();
      window.dispatchEvent(new Event('itdb:changed'));
      toast(cb.checked ? 'Учёт лицензий включён' : 'Учёт лицензий скрыт ото всех');
      location.reload();
    }, e.currentTarget) }, 'Сохранить')));
}

// ===================== ПО с компьютера (WMI) =====================
const STATE_LABEL = { new: 'новая', version: 'другая версия', same: 'уже в карточке' };

/** Собрать установленное ПО с компьютера и перенести отмеченное в карточку */
export function softwareFromPc(device, onDone) {
  licStyles();
  const box = h('div', h('p', 'Сбор списка программ с компьютера ', h('b', device.hostname || device.ip_address), '… Обычно это 10–60 секунд.'));
  const apply = h('button.btn.primary', { disabled: true }, 'Перенести отмеченное');
  const m = modal({ title: 'ПО с компьютера (WMI)', body: box, size: 'wide',
    footer: [h('button.btn.subtle', { onclick: () => { stopped = true; m.close(); } }, 'Закрыть'), apply] });
  let stopped = false;
  let checks = [];

  const draw = (r) => {
    const fresh = r.items.filter((x) => x.state === 'new');
    const ver = r.items.filter((x) => x.state === 'version');
    const same = r.items.filter((x) => x.state === 'same');
    checks = [];
    const row = (x, kind, on) => {
      const cb = h('input', { type: 'checkbox', checked: on });
      checks.push({ cb, x, kind });
      return h('tr', h('td', { style: { width: '28px' } }, cb), h('td', h('b', x.name), x.publisher ? h('div.small.muted', x.publisher) : null),
        h('td.small', kind === 'update' ? [h('span.muted', x.card_version || '—'), ' → ', h('b', x.version)] : (x.version || '')),
        h('td.small.muted', x.installed ? fmtDay(x.installed) : ''));
    };
    const sec = (title, n) => h('tr.sw-sec', h('td', { colspan: 4 }, `${title}: ${n}`));
    clear(box,
      h('p', `Найдено программ на ${r.target}: `, h('b', String(r.items.length)), '. Отметьте, что перенести в карточку.'),
      h('div.sw-list', h('table.list', h('tbody',
        fresh.length ? [sec('Новые — добавить в карточку', fresh.length), fresh.map((x) => row(x, 'add', true))] : null,
        ver.length ? [sec('Другая версия — обновить', ver.length), ver.map((x) => row(x, 'update', true))] : null,
        r.missing.length ? [sec('В карточке, но на компьютере не найдено — удалить из карточки', r.missing.length),
          r.missing.map((x) => row({ ...x, publisher: '' }, 'remove', false))] : null,
        same.length ? [sec('Уже в карточке, без изменений', same.length),
          same.map((x) => h('tr', h('td'), h('td', x.name), h('td.small', x.version || ''), h('td.small.muted', '')))] : null))),
      h('p.hint', 'Системные компоненты и обновления Windows не показываются. Добавленные программы попадают и в общий справочник ПО.'));
    apply.disabled = !fresh.length && !ver.length && !r.missing.length;
  };

  const poll = async () => {
    if (stopped) return;
    const r = await api.get(`/api/netinfo/device/${device.id}/software`);
    if (!r || !r.finished_at) { setTimeout(() => poll().catch((e) => clear(box, h('div.error-box', e.message))), 2000); return; }
    if (r.error) { clear(box, h('div.error-box', 'Не удалось собрать список программ: ', r.error)); return; }
    draw(r);
  };
  apply.addEventListener('click', () => run(async () => {
    const pick = (k) => checks.filter((c) => c.kind === k && c.cb.checked).map((c) => c.x);
    const r = await api.post(`/api/netinfo/device/${device.id}/software/apply`, {
      add: pick('add'), update: pick('update').map((x) => ({ card_id: x.card_id, version: x.version })), remove: pick('remove').map((x) => x.card_id),
    });
    m.close();
    toast(`Добавлено: ${r.added}, обновлено: ${r.updated}, удалено: ${r.removed}`);
    onDone && onDone();
  }, apply));
  run(async () => {
    await api.post(`/api/netinfo/device/${device.id}/software`);
    await poll();
  });
}

export { isSuper, state };
