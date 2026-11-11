// Сканирование сети: найти технику в сети, сравнить с базой, добавить новую или дополнить существующие карточки
import { h, clear, api, toast, run, modal, fmtDate, typeDot } from '../ui.js';
import { state, isSuper, lookupItems, createLookup, invalidateLookups } from '../store.js';
import { renderCompare, applyToDevice } from './netinfo.js';

const STATUS = {
  new: ['Новое', 'blue'],
  diff: ['Есть отличия', 'yellow'],
  match: ['В базе', 'green'],
  ignored: ['Скрыто', ''],
};
const KIND = {
  computer: 'Компьютер', notebook: 'Ноутбук', server: 'Сервер', printer: 'Принтер / МФУ', network: 'Сетевое устройство', unknown: 'Неизвестно',
};
const STRENGTH = { strong: 'точно', name: 'вероятно', ip: 'только по IP — проверьте' };
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s()®™]+/g, ' ').trim();

let filter = 'pending';

/** Отметить устройство из «Ждут решения» решённым */
const markHandled = (key, action) => api.post('/api/netscan/handled', { key, action }).catch(() => {});
let timer = null;

/** Тип техники для нового устройства по тому, что нашли в сети */
function guessType(host) {
  const types = state.meta.types;
  const byCode = (c) => types.find((t) => t.code.toUpperCase() === c);
  const byName = (re) => types.find((t) => re.test(t.name));
  const mfp = /mfp|mfu|мфу|ecosys m|i-sensys mf|workcentre|multifunction/i.test(`${host.snmp?.model || ''} ${host.snmp?.description || ''}`);
  const pick = {
    computer: () => byCode('PC') || byName(/пк|компьютер/i),
    notebook: () => byCode('NB') || byName(/ноутбук/i),
    server: () => byCode('SRV') || byName(/сервер/i),
    printer: () => (mfp ? byCode('MFU') || byName(/мфу/i) : null) || byCode('PRN') || byName(/принтер/i),
  }[host.kind];
  return (pick && pick()) || byCode('OTH') || byName(/проч/i) || types[types.length - 1];
}

/** Создать карточку по найденному устройству; справочные значения находятся или добавляются */
async function createDevice(host, typeId) {
  const sug = host.suggest || {};
  const body = { type_id: typeId };
  for (const f of state.meta.coreFields) {
    const v = sug[f.key];
    if (!v) continue;
    if (f.kind === 'lookup') {
      const items = await lookupItems(f.lookup);
      const found = items.find((i) => norm(i.label) === norm(v));
      body[f.col] = found ? found.id : (await createLookup(f.lookup, v)).id;
    } else body[f.key] = v;
  }
  if (!body.ip_address) body.ip_address = host.ip;
  const r = await api.post('/api/devices', body);
  return r.id;
}

function portsText(h0) {
  const names = { 80: 'веб', 443: 'веб', 8080: 'веб', 3389: 'RDP', 445: 'SMB', 135: 'WMI', 5985: 'WinRM', 9100: 'печать', 515: 'печать', 631: 'печать', 22: 'SSH', 23: 'Telnet', 21: 'FTP', 5900: 'VNC', 139: 'NetBIOS' };
  return [...new Set(h0.ports.map((p) => names[p.port] || p.port))].join(', ');
}

export async function renderNetscan(root) {
  document.title = 'Сканирование сети — ИТ Инвентарь';
  clearTimeout(timer);
  let data;
  const body = h('div');
  const nets = h('input', { type: 'text', placeholder: 'Например: 10.0.1.0/24, 10.0.2.10-10.0.2.50' });
  const wmi = h('input', { type: 'checkbox' });
  const scanBtn = h('button.btn.primary', 'Сканировать');
  const progress = h('div');
  // Сканирование по расписанию
  const schMode = h('select', { style: { width: 'auto' } }, [['off', 'выключено'], ['daily', 'каждый день'], ['weekly', 'раз в неделю']].map(([v, l]) => h('option', { value: v }, l)));
  const schDay = h('select', { style: { width: 'auto' } }, ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'].map((l, i) => h('option', { value: i + 1 }, 'в ' + l.replace(/а$/, 'у'))));
  const schTime = h('input', { type: 'time', value: '01:00', style: { width: '110px' } });
  const schWmi = h('input', { type: 'checkbox' });
  const schInfo = h('div.muted.small', { style: { flexBasis: '100%' } });
  const schBox = h('div.ns-schedule.row.wrap', { style: { gap: '8px', margin: '10px 0 4px', alignItems: 'center' } },
    h('strong.small', 'По расписанию:'), schMode, schDay, h('span.small', 'в'), schTime,
    h('label.check.small', { style: { whiteSpace: 'nowrap' } }, schWmi, 'собирать WMI'),
    h('button.btn.sm', { onclick: (e) => run(async () => {
      await api.put('/api/netscan/schedule', { mode: schMode.value, weekday: Number(schDay.value), time: schTime.value, wmi: schWmi.checked });
      toast(schMode.value === 'off' ? 'Сканирование по расписанию выключено' : 'Расписание сохранено');
    }, e.currentTarget) }, 'Сохранить'),
    schInfo);
  const syncSch = () => { schDay.hidden = schMode.value !== 'weekly'; };
  schMode.addEventListener('change', syncSch);
  let schLoaded = false;

  scanBtn.addEventListener('click', () => run(async () => {
    await api.post('/api/netscan', { networks: nets.value, wmi: wmi.checked });
    toast('Сканирование запущено');
    await load();
  }, scanBtn));

  clear(root,
    h('div.breadcrumbs', h('a', { href: '#/' }, 'Служба ИТ'), h('span.sep', '/'), h('span', 'Сканирование сети')),
    h('div.page-head', h('h1', 'Сканирование сети')),
    h('p.muted', { style: { marginTop: '-8px' } },
      'Поиск техники в сети: найденные устройства сравниваются с базой — новые можно добавить, у известных дополнить карточку.'),
    h('div.ns-form',
      h('label.field.ns-nets', h('span', 'Какие сети сканировать'), nets),
      h('label.check.ns-wmi', wmi, 'Собрать характеристики компьютеров (WMI) — дольше'),
      scanBtn),
    schBox,
    progress,
    body);

  async function load() {
    data = await api.get('/api/netscan');
    if (!schLoaded && data.schedule) {
      schLoaded = true;
      schMode.value = data.schedule.mode; schDay.value = String(data.schedule.weekday); schTime.value = data.schedule.time; schWmi.checked = !!data.schedule.wmi;
      syncSch();
      clear(schInfo, 'Сети — из настроек «Сведения из сети» (или сеть сервера). Новая техника попадёт в «Ждут решения», редакторам придёт уведомление.',
        data.schedule.last_auto ? ` Последний запуск: ${new Date(data.schedule.last_auto).toLocaleString('ru-RU')}.` : '');
    }
    // Сети: последнего сканирования, иначе — из настроек или сети самого сервера
    if (!nets.value) nets.value = data.result?.networks || data.defaults.networks;
    wmi.disabled = !data.defaults.wmi_enabled || !data.defaults.has_account;
    wmi.parentElement.title = wmi.disabled ? 'WMI выключен или не указана учётная запись — Инвентарь → Настройки → «Сведения из сети»' : '';
    const running = data.job && !data.job.finished_at;
    scanBtn.disabled = running;
    scanBtn.textContent = running ? 'Идёт сканирование…' : 'Сканировать';
    renderProgress();
    renderResult();
    clearTimeout(timer);
    if (running && document.body.contains(root) && location.hash.startsWith('#/netscan')) timer = setTimeout(() => load().catch(() => {}), 1500);
  }

  function renderProgress() {
    const j = data.job;
    if (!j || j.finished_at) {
      clear(progress, j?.error ? h('div.ni-note.err', `Сканирование прервано: ${j.error}`) : null);
      return;
    }
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    clear(progress, h('div.ns-progress',
      h('div.ns-phase', h('span.spinner'), `${j.phase}: ${j.done} из ${j.total}`, j.found ? h('span.muted', ` · отвечают: ${j.found}`) : null),
      h('div.ni-bar.big', h('div', { style: { width: `${pct}%`, background: 'var(--b400, #0052CC)' } }))));
  }

  function renderResult() {
    const r = data.result || { hosts: [], missing: [] };
    const pending = data.pending || [];
    if (!data.result && !pending.length) {
      clear(body, h('div.ni-note', 'Сканирование ещё не проводилось. Проверьте список сетей и нажмите «Сканировать».'));
      return;
    }
    const count = (s) => r.hosts.filter((x) => x.status === s).length;
    const tabs = [['pending', 'Ждут решения'], ['new', 'Новые'], ['diff', 'С отличиями'], ['match', 'Совпадают'], ['all', 'Все'], ['ignored', 'Скрытые']];
    const list = filter === 'pending' ? pending : r.hosts.filter((x) => (filter === 'all' ? x.status !== 'ignored' : x.status === filter));
    const bulk = (filter === 'new' || filter === 'pending');
    const types = state.meta.types;

    const checks = new Map(); // ip → { cb, sel }
    const rows = list.map((x) => {
      const cb = x.status === 'new' ? h('input', { type: 'checkbox' }) : null;
      const sel = x.status === 'new' ? h('select.ns-type', types.map((t) => h('option', { value: t.id, selected: t.id === guessType(x)?.id }, t.name))) : null;
      if (cb) checks.set(x.ip, { cb, sel, host: x });
      const name = x.suggest.hostname || x.dns_name || '';
      const what = [KIND[x.kind] || '', x.suggest.model, x.wmi?.os?.replace(/^(Microsoft|Майкрософт)\s+/i, '')].filter(Boolean).join(' · ');
      const actions = [];
      if (x.status === 'new') {
        actions.push(sel, h('button.btn.sm.primary', { onclick: (e) => run(async () => { const id = await createDevice(x, Number(sel.value)); await markHandled(x.ignore_key, 'added'); toast(`Добавлено: ${name || x.ip}`); invalidateLookups(); afterChange(id); }, e.currentTarget) }, 'Добавить'));
      }
      if (x.status === 'diff') actions.push(h('button.btn.sm.primary', { onclick: () => openCompare(x) }, `Дополнить (${x.diff.length})`));
      if (x.device) actions.push(h('a.btn.sm', { href: `#/devices/${x.device.id}` }, 'Открыть'));
      if (filter === 'pending') {
        actions.push(h('button.btn.sm.subtle', {
          title: 'Ничего не менять: убрать из «Ждут решения» (вернётся, если при следующих сканированиях изменятся данные)',
          onclick: (e) => run(async () => { await markHandled(x.ignore_key, 'skipped'); toast('Оставлено как есть'); await load(); }, e.currentTarget),
        }, 'Оставить как есть'));
      }
      actions.push(x.status === 'ignored'
        ? h('button.btn.sm.subtle', { onclick: (e) => run(async () => { await api.post('/api/netscan/ignore', { key: x.ignore_key, ignore: false }); await load(); }, e.currentTarget) }, 'Вернуть')
        : h('button.btn.sm.subtle', { title: 'Больше не предлагать (телефон, гостевой ноутбук…)', onclick: (e) => run(async () => { await api.post('/api/netscan/ignore', { key: x.ignore_key }); toast('Устройство скрыто'); await load(); }, e.currentTarget) }, 'Скрыть'));
      return h('tr',
        h('td', cb),
        h('td', h(`span.lozenge${STATUS[x.status][1] ? '.' + STATUS[x.status][1] : ''}`, STATUS[x.status][0])),
        h('td.nowrap', h('b', x.ip), x.arp_only ? h('div.small.muted', 'виден только в ARP') : null,
          x.first_seen ? h('div.small.muted', { title: `Последний раз в сети: ${fmtDate(x.last_seen)}` }, `найдено ${fmtDate(x.first_seen, false)}`) : null),
        h('td.nowrap', name || h('span.muted', '—'), x.netbios?.user ? h('div.small.muted', `вошёл: ${x.netbios.user}`) : null),
        h('td.nowrap.small', x.mac || x.suggest.mac_address || h('span.muted', '—')),
        h('td', what || h('span.muted', '—'), x.wmi_error ? h('div.small.danger-text', { title: x.wmi_error }, 'WMI: нет доступа') : null),
        h('td.small', portsText(x) || h('span.muted', '—')),
        h('td', x.device
          ? h('div', h('a', { href: `#/devices/${x.device.id}` }, typeDot({ name: x.device.type_name, color: x.device.type_color }), ' ', x.device.key, ' ', x.device.hostname || x.device.model || ''),
            h('div.small.muted', `по: ${x.reason.join(', ')} — ${STRENGTH[x.strength]}`),
            x.conflict ? h('div.small.danger-text', `Несколько карточек: ${x.conflict.map((c) => c.key).join(', ')}`) : null,
            x.status === 'diff' ? h('div.small', 'отличается: ', x.diff.map((f) => state.meta.coreFields.find((c) => c.key === f)?.label || f).join(', ')) : null)
          : h('span.muted', 'нет в базе')),
        h('td.ns-actions', actions));
    });

    const addSel = h('button.btn.primary', 'Добавить отмеченные');
    addSel.addEventListener('click', () => run(async () => {
      const items = [...checks.values()].filter((c) => c.cb.checked);
      if (!items.length) throw new Error('Отметьте устройства галочками');
      let n = 0;
      for (const c of items) { await createDevice(c.host, Number(c.sel.value)); await markHandled(c.host.ignore_key, 'added'); n++; }
      invalidateLookups();
      toast(`Добавлено устройств: ${n}`);
      afterChange();
    }, addSel));
    const all = h('input', { type: 'checkbox', title: 'Отметить все', onchange: (e) => checks.forEach((c) => { c.cb.checked = e.target.checked; }) });

    clear(body,
      data.result ? h('div.ns-summary',
        h('span', 'Последнее сканирование ', h('b', fmtDate(r.finished_at || r.started_at)), r.scanned_by ? ` (${r.scanned_by})` : '', ` · сети: ${r.networks}`),
        h('span.muted', ` · найдено устройств: ${r.hosts.length}`)) : null,
      h('div.tabs', tabs.map(([k, l]) => h('button.tab' + (filter === k ? '.active' : '') + (k === 'pending' ? '.ns-pending-tab' : ''), { onclick: () => { filter = k; renderResult(); } },
        l, ' ', h('span.badge', k === 'pending' ? pending.length : k === 'all' ? r.hosts.length - count('ignored') : count(k))))),
      filter === 'pending' ? h('p.muted.small', { style: { margin: '0 0 10px' } },
        'Техника со всех сканирований, по которой ещё ничего не сделано: новая или с отличиями от карточки. Список сохраняется — ',
        'к нему можно вернуться в любой момент; новые сканирования его пополняют. Решённое («Добавить», «Дополнить», «Оставить как есть», «Скрыть») из списка уходит.') : null,
      bulk && checks.size ? h('div.ns-bulk', addSel, h('span.muted.small', 'Тип техники подобран автоматически — проверьте перед добавлением.')) : null,
      list.length ? h('div.table-wrap', h('table.list.ns-table',
        h('thead', h('tr', h('th', bulk && checks.size ? all : ''), h('th', 'Статус'), h('th', 'IP'), h('th', 'Имя'), h('th', 'MAC'),
          h('th', 'Что это'), h('th', 'Службы'), h('th', 'В базе'), h('th', ''))),
        h('tbody', rows)))
        : h('div.ni-note', { style: { marginTop: '12px' } }, { pending: 'Всё найденное разобрано — решения ждать нечему.', new: 'Новых устройств нет — всё найденное уже есть в базе.', diff: 'Отличий нет.', match: 'Совпадений нет.', all: 'Ничего не найдено.', ignored: 'Скрытых устройств нет.' }[filter]),
      filter !== 'pending' && r.missing.length ? h('details.ns-missing',
        h('summary', `Есть в базе, но не ответили при сканировании: ${r.missing.length}`),
        h('p.muted.small', 'Техника с IP-адресом из просканированных сетей. Возможно, выключена, переехала или списана.'),
        h('div.table-wrap', h('table.list.ns-table',
          h('thead', h('tr', h('th', 'Устройство'), h('th', 'IP'), h('th', 'Модель'), h('th', 'Пользователь'))),
          h('tbody', r.missing.map((d) => h('tr',
            h('td', h('a', { href: `#/devices/${d.id}` }, typeDot({ name: d.type_name, color: d.type_color }), ' ', d.key, ' ', d.hostname || '')),
            h('td', d.ip_address), h('td', d.model || '—'), h('td', d.employee || '—')))))))
        : null);
  }

  // Дополнить карточку: то же окно сравнения, что в «Сведениях из сети»
  async function openCompare(x) {
    const { device } = await api.get('/api/devices/' + x.device.id);
    const box = h('div');
    const m = modal({ title: `Дополнить карточку ${x.device.key} ${device.hostname || ''}`, body: box, size: 'wide' });
    clear(box, h('p.muted', `Найдено в сети: ${x.ip}${x.suggest.hostname ? ' · ' + x.suggest.hostname : ''}. Совпадение по: ${x.reason.join(', ')}.`),
      renderCompare(device, x.suggest, async (keys, values) => {
        await applyToDevice(device, values, keys);
        await markHandled(x.ignore_key, 'updated');
        invalidateLookups();
        toast(`Карточка дополнена: ${keys.length} пол.`);
        m.close();
        afterChange();
      }));
  }

  function afterChange() {
    window.dispatchEvent(new Event('itdb:changed'));
    load().catch((e) => toast(e.message, 'err'));
  }

  if (isSuper()) {
    root.querySelector('.ns-form').append(h('a.small', { href: '#/settings/netprobe', style: { alignSelf: 'center' } }, 'Сети по умолчанию — в настройках'));
  }
  await load();
}
