// Окно «Сведения из сети»: сеть, Active Directory, WMI (компьютер), SNMP (принтер) и сравнение с карточкой
import { h, clear, api, toast, run, modal, fmtDate, timeAgo } from '../ui.js';
import { state, isSuper, lookupItems, createLookup } from '../store.js';

export const SECTIONS = {
  network: 'Сеть',
  ad: 'Active Directory',
  wmi: 'Компьютер (WMI)',
  snmp: 'Принтер (SNMP)',
};
// Поля карточки, которые можно заполнить из сети
const APPLY_FIELDS = ['hostname', 'model', 'serial_number', 'cpu', 'ram', 'storage', 'os', 'ip_address', 'mac_address'];
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s()®™]+/g, ' ').trim();

const gb = (v) => (v == null || v === '' ? '—' : `${String(v).replace('.', ',')} ГБ`);
const dt = (v) => (v ? fmtDate(v) : '—');
const days = (v) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 86400000) : null);

/** Строки «название — значение»; пустые пропускаются */
function kv(rows) {
  return h('div.ni-kv', rows.filter((r) => r && r[1] !== '' && r[1] != null && r[1] !== '—').map(([k, v]) => h('div.ni-row', h('div.ni-k', k), h('div.ni-v', v))));
}
function table(head, rows) {
  if (!rows.length) return null;
  return h('div.table-wrap', h('table.list.ni-table', h('thead', h('tr', head.map((x) => h('th', x)))),
    h('tbody', rows.map((r) => h('tr', r.map((c) => h('td', c ?? '—')))))));
}
const block = (title, ...children) => h('div.ni-block', h('h3', title), ...children);

// ---------- Разделы ----------
function renderNetwork(d) {
  const ports = d.ports || [];
  const has = (p) => ports.some((x) => x.port === p);
  const ip = d.used_ip;
  const links = [];
  if (ip && (has(80) || has(8080))) links.push(h('a.btn.sm', { href: `http://${ip}${has(80) ? '' : ':8080'}/`, target: '_blank', rel: 'noopener' }, 'Открыть веб-интерфейс'));
  if (ip && has(443)) links.push(h('a.btn.sm', { href: `https://${ip}/`, target: '_blank', rel: 'noopener' }, 'Веб-интерфейс (HTTPS)'));
  if (has(3389)) {
    links.push(h('button.btn.sm', {
      onclick: () => {
        const host = d.hostname || ip;
        const blob = new Blob([`full address:s:${host}\r\nprompt for credentials:i:1\r\n`], { type: 'application/x-rdp' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${host}.rdp` });
        document.body.append(a); a.click(); a.remove();
      },
    }, 'Подключиться по RDP'));
  }
  const nb = d.netbios || {};
  return h('div',
    kv([
      ['В сети', d.alive ? h('span.lozenge.green', 'отвечает') : h('span.lozenge.red', 'не отвечает')],
      ['Ping', d.ping ? `${d.ping_ms ?? '<1'} мс` : 'нет ответа (может быть запрещён брандмауэром)'],
      ['IP-адрес', ip || '—'],
      d.hostname && ['IP по DNS', d.dns_ip || 'имя не найдено в DNS'],
      ['Имя по DNS', d.dns_name],
      ['MAC-адрес', d.mac || 'не определён (устройство в другой подсети)'],
      ['Имя NetBIOS', nb.computer],
      ['Домен / рабочая группа', nb.workgroup],
      ['Вошедший пользователь', nb.user],
    ]),
    block('Открытые порты', ports.length
      ? h('div.ni-ports', ports.map((p) => h('span.ni-port', h('b', p.port), ' ', p.label)))
      : h('p.muted', 'Ни один из проверяемых портов не открыт')),
    links.length ? h('div.row.ni-links', links) : null);
}

function renderAD(d) {
  if (!d.found) {
    return h('div', h('div.ni-note', `Компьютер «${d.name || ''}» не найден в Active Directory (искали: ${d.naming_context || 'весь домен'}).`),
      d.base_error ? h('div.ni-note.err', `Место поиска из настроек не подошло: ${d.base_error}. Проверьте поле «Где искать (корневой DN)» — обычно его можно оставить пустым.`) : null);
  }
  const ou = (d.dn || '').split(',').filter((p) => /^OU=/i.test(p)).map((p) => p.slice(3)).reverse().join(' / ');
  const ago = days(d.last_logon);
  // Найден не там, где указано в настройках, — подсказываем поправить настройку
  const where = d.configured_base && d.via && d.via !== 'base'
    ? h('div.ni-note', `Компьютер найден ${d.via === 'gc' ? 'через глобальный каталог' : 'в домене контроллера'} (${d.naming_context}), а не в «${d.configured_base}», указанном в настройках. `
      + 'Проверьте поле «Где искать (корневой DN)» — обычно его можно оставить пустым.')
    : null;
  return h('div', where,
    kv([
      ['Имя', d.name], ['DNS-имя', d.dns],
      ['Состояние', d.disabled ? h('span.lozenge.red', 'отключён в домене') : h('span.lozenge.green', 'включён')],
      ['ОС', [d.os, d.service_pack].filter(Boolean).join(' ')], ['Версия ОС', d.os_version],
      ['Последний вход в домен', d.last_logon ? h('span', fmtDate(d.last_logon), ago > 90 ? h('span.lozenge.yellow', { style: { marginLeft: '8px' } }, `${ago} дн. назад`) : h('span.muted', ` (${timeAgo(d.last_logon)})`)) : '—'],
      ['Создан в домене', dt(d.created)], ['Изменён', dt(d.changed)],
      ['Подразделение (OU)', ou], ['Описание', d.description], ['Расположение', d.location], ['Ответственный', d.managed_by],
      d.is_dc && ['Роль', 'Контроллер домена'],
    ]),
    d.groups?.length ? block('Группы', h('div.ni-ports', d.groups.map((g) => h('span.ni-port', g)))) : null);
}

function renderWMI(d) {
  const cpu = d.cpu || [];
  const vols = d.volumes || [];
  return h('div',
    block('Система', kv([
      ['Имя', d.hostname], ['Домен', d.domain], ['Вошедший пользователь', d.user || 'никто не вошёл'],
      ['ОС', [d.os, d.os_arch].filter(Boolean).join(', ')], ['Версия (сборка)', d.os_version],
      ['Установлена', dt(d.install_date)], ['Включён', d.last_boot ? `${fmtDate(d.last_boot)} (${timeAgo(d.last_boot)})` : '—'],
      ['Подключение', d.protocol === 'Dcom' ? 'WMI (DCOM)' : d.protocol === 'Wsman' ? 'WinRM' : d.protocol],
    ])),
    block('Оборудование', kv([
      ['Производитель', d.manufacturer], ['Модель', [d.model, d.product_version && d.product_version !== d.model ? `(${d.product_version})` : ''].filter(Boolean).join(' ')],
      ['Серийный номер', d.serial], ['Материнская плата', d.board], ['BIOS', d.bios],
      ['Процессор', cpu.map((c) => `${c.name}${c.cores ? ` — ${c.cores} ядер / ${c.threads} потоков` : ''}`).join('; ')],
      ['Оперативная память', d.ram_gb != null ? `${gb(d.ram_gb)}${d.ram_free_gb != null ? `, свободно ${gb(d.ram_free_gb)}` : ''}` : '—'],
      ['Видеокарта', (d.gpu || []).join('; ')],
    ])),
    d.memory_modules?.length ? block('Модули памяти', table(['Слот', 'Объём', 'Частота', 'Производитель', 'Артикул'],
      d.memory_modules.map((m) => [m.slot, gb(m.gb), m.mhz ? `${m.mhz} МГц` : '—', m.maker, m.part]))) : null,
    d.disks?.length ? block('Диски', table(['Модель', 'Тип', 'Объём', 'Подключение', 'Серийный №'],
      d.disks.map((x) => [x.model, x.usb ? 'USB' : x.kind || '—', x.gb ? `${x.gb} ГБ` : '—', x.iface, x.serial]))) : null,
    vols.length ? block('Тома', table(['Диск', 'Метка', 'Размер', 'Свободно', ''],
      vols.map((v) => {
        const used = v.size_gb ? Math.round(((v.size_gb - v.free_gb) / v.size_gb) * 100) : 0;
        return [v.name, v.label, gb(v.size_gb), gb(v.free_gb),
          h('div.ni-bar', { title: `Занято ${used}%` }, h('div', { style: { width: `${used}%`, background: used > 90 ? 'var(--r400, #DE350B)' : used > 75 ? '#FF8B00' : 'var(--b400, #0065FF)' } }))];
      }))) : null,
    d.nics?.length ? block('Сетевые адаптеры', table(['Адаптер', 'MAC', 'IP', 'DHCP'],
      d.nics.map((n) => [n.name, n.mac, n.ip, n.dhcp ? 'да' : 'нет']))) : null);
}

function renderSNMP(d) {
  return h('div',
    kv([
      ['Модель', d.model], ['Серийный номер', d.serial], ['Имя', d.name], ['Описание', d.description],
      ['Счётчик страниц', d.page_count != null ? d.page_count.toLocaleString('ru-RU') : ''],
      ['Расположение', d.location], ['Контакт', d.contact], ['Работает', d.uptime],
      ['Протокол', `SNMP ${d.version}, сообщество «${d.community}»`],
    ]),
    d.supplies?.length ? block('Расходные материалы', h('div.ni-supplies', d.supplies.map((s) => h('div.ni-supply',
      h('div.ni-supply-name', s.name),
      s.percent != null
        ? h('div.ni-bar.big', h('div', { style: { width: `${Math.max(0, Math.min(100, s.percent))}%`, background: s.percent < 15 ? '#DE350B' : s.percent < 30 ? '#FF8B00' : '#36B37E' } }))
        : null,
      h('div.ni-supply-val', s.percent != null ? `${s.percent}%` : 'уровень неизвестен'))))) : null);
}

const RENDER = { network: renderNetwork, ad: renderAD, wmi: renderWMI, snmp: renderSNMP };

export function renderSection(key, sec) {
  if (!sec) return h('div.ni-note', 'Ещё не опрашивалось — нажмите «Обновить».');
  const parts = [];
  if (sec.state === 'running') parts.push(h('div.ni-running', h('span.spinner'), 'Опрашивается…', key === 'wmi' ? h('span.muted', ' WMI может отвечать до двух минут') : null));
  if (sec.state === 'off') parts.push(h('div.ni-note', 'Отключено в настройках опроса.'));
  if (['error', 'skipped', 'empty'].includes(sec.state)) parts.push(h(`div.ni-note${sec.state === 'error' ? '.err' : ''}`, sec.error || 'Нет данных'));
  if (sec.state === 'done' && sec.data) parts.push(RENDER[key](sec.data));
  else if (sec.previous?.data) {
    parts.push(h('div.ni-prev', `Ниже — данные, полученные ${fmtDate(sec.previous.at)}:`), RENDER[key](sec.previous.data));
  }
  return h('div', parts);
}

// ---------- Сравнение с карточкой ----------
export function renderCompare(device, suggest, onApply) {
  const fields = state.meta.coreFields.filter((f) => APPLY_FIELDS.includes(f.key) && suggest[f.key]);
  if (!fields.length) return h('div.ni-note', 'Пока нечего сравнивать: нет данных WMI или SNMP.');
  const checks = {};
  const rows = fields.map((f) => {
    const cur = device[f.key] ?? '';
    const val = suggest[f.key];
    const same = norm(cur) === norm(val);
    const cb = h('input', { type: 'checkbox', checked: !same && !cur ? true : !same && f.key !== 'hostname' });
    if (!same) checks[f.key] = cb;
    return h('tr' + (same ? '.same' : '.diff'),
      h('td', f.label),
      h('td', cur || h('span.muted', 'не заполнено')),
      h('td', val),
      h('td.nowrap', same ? h('span.ni-ok', '✓ совпадает') : h('label.ni-take', cb, ' перенести')));
  });
  const diffs = Object.keys(checks).length;
  const btn = h('button.btn.primary', { disabled: !diffs }, 'Перенести отмеченное в карточку');
  btn.addEventListener('click', () => run(async () => {
    const keys = Object.keys(checks).filter((k) => checks[k].checked);
    if (!keys.length) return toast('Ничего не отмечено', 'warn');
    await onApply(keys);
  }, btn));
  return h('div',
    h('p.muted', diffs
      ? 'Отмеченные значения будут записаны в карточку (в истории изменений будет видно, что поменялось). Новые значения справочников добавятся сами.'
      : 'Все сведения совпадают с карточкой.'),
    h('div.table-wrap', h('table.list.ni-table.ni-compare',
      h('thead', h('tr', h('th', 'Поле'), h('th', 'В карточке'), h('th', 'Из сети'), h('th', ''))),
      h('tbody', rows))),
    diffs ? h('div.row', { style: { marginTop: '12px', justifyContent: 'flex-end' } }, btn) : null);
}

/** Записать выбранные значения в карточку: справочные поля — по значению справочника (создаётся при необходимости) */
export async function applyToDevice(device, suggest, keys) {
  const body = {};
  for (const k of keys) {
    const f = state.meta.coreFields.find((x) => x.key === k);
    const v = suggest[k];
    if (f.kind === 'lookup') {
      const items = await lookupItems(f.lookup);
      const found = items.find((i) => norm(i.label) === norm(v));
      body[f.col] = found ? found.id : (await createLookup(f.lookup, v)).id;
    } else body[k] = v;
  }
  await api.patch('/api/devices/' + device.id, body);
}

// ---------- Окно ----------
export async function openNetInfo(device, onChanged) {
  const body = h('div.ni');
  let info = null;
  let tab = null;
  let timer = null;
  let closed = false;
  const refreshBtn = h('button.btn.primary', 'Обновить');
  const m = modal({
    title: `Сведения из сети — ${device.hostname || device.ip_address}`, body, size: 'wide.ni-modal',
    onClose: () => { closed = true; clearTimeout(timer); },
  });

  const load = async () => {
    info = await api.get(`/api/netinfo/device/${device.id}`);
    render();
    if (info.job && !info.job.done && !closed) timer = setTimeout(() => load().catch((e) => toast(e.message, 'err')), 1500);
  };

  refreshBtn.addEventListener('click', () => run(async () => {
    await api.post(`/api/netinfo/device/${device.id}/refresh`);
    clearTimeout(timer);
    await load();
  }, refreshBtn));

  function render() {
    const running = info.job && !info.job.done;
    const sections = running ? info.job.sections : info.saved?.sections || (info.job?.done ? info.job.sections : null) || {};
    const suggest = info.saved?.suggest || {};
    refreshBtn.disabled = running || !info.target.usable;
    refreshBtn.textContent = running ? 'Идёт опрос…' : info.saved ? 'Обновить' : 'Опросить';

    // Какие вкладки показывать
    const printer = info.target.kind === 'printer';
    const hidden = (k, s) => !s || (['off', 'skipped', 'empty'].includes(s.state) && !s.previous);
    const tabs = Object.keys(SECTIONS).filter((k) => {
      const s = sections[k];
      if (k === 'network') return true;
      if (k === 'wmi') return !printer && (running || !hidden(k, s) || s?.state === 'skipped');
      if (k === 'snmp') return printer || (s && !hidden(k, s));
      if (k === 'ad' && printer) return false;
      return running || !hidden(k, s);
    });
    const diffCount = Object.entries(suggest).filter(([k, v]) => APPLY_FIELDS.includes(k) && norm(device[k]) !== norm(v)).length;
    if (info.saved) tabs.push('compare');
    if (!tab || !tabs.includes(tab)) tab = diffCount && !running ? 'compare' : printer ? (tabs.includes('snmp') ? 'snmp' : 'network') : tabs.includes('wmi') ? 'wmi' : 'network';

    const dot = (s) => (!s ? '' : s.state === 'running' ? '.run' : s.state === 'done' ? '.ok' : s.state === 'error' ? '.err' : '.off');
    const bar = h('div.tabs', tabs.map((k) => h('button.tab' + (k === tab ? '.active' : ''), { onclick: () => { tab = k; render(); } },
      k === 'compare' ? ['Сравнение с карточкой', diffCount ? h('span.badge.ni-badge', diffCount) : null]
        : [h('span.ni-dot' + dot(sections[k])), SECTIONS[k]])));

    const content = tab === 'compare'
      ? renderCompare(device, suggest, async (keys) => {
        await applyToDevice(device, suggest, keys);
        toast(`В карточку перенесено полей: ${keys.length}`);
        m.close();
        onChanged && onChanged();
      })
      : renderSection(tab, sections[tab]);

    const hints = [];
    if (!info.target.usable) hints.push(h('div.ni-note.err', info.target.bad ? 'Сетевое имя или IP-адрес записаны с ошибкой — исправьте их в карточке.' : 'В карточке не указаны сетевое имя или IP-адрес.'));
    if (!info.configured) {
      hints.push(h('div.ni-note', 'Учётная запись для Active Directory и WMI ещё не указана — без неё доступны только сетевые проверки. ',
        isSuper() ? h('a', { href: '#/settings/netprobe', onclick: () => m.close() }, 'Открыть настройки') : 'Её указывает администратор портала.'));
    }

    clear(body,
      h('div.ni-head',
        h('div.grow',
          h('div', h('b', device.hostname || '—'), h('span.muted', '  ·  '), device.ip_address || h('span.muted', 'IP не указан')),
          h('div.muted.small', running ? `Опрос начат ${fmtDate(info.job.started_at)}`
            : info.saved ? `Получено ${fmtDate(info.saved.collected_at)}${info.saved.collected_by ? ` (${info.saved.collected_by})` : ''}` : 'Сведения ещё не запрашивались')),
        refreshBtn),
      hints,
      bar,
      h('div.ni-body', content));
  }

  try {
    await load();
    // Первое открытие — сразу опрашиваем
    if (!info.saved && !info.job && info.target.usable) refreshBtn.click();
  } catch (e) {
    clear(body, h('div.ni-note.err', e.message));
  }
}
