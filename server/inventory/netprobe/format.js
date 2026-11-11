// Значения для карточки техники из данных WMI / SNMP / сети — по шаблонам, которые задаёт служба ИТ,
// и списку замен («как пришло из сети» → «как принято у нас в базе»).
//
// Шаблон — текст с переменными в фигурных скобках, например «{модель}» для процессора или «{объём} ГБ {тип}»
// для памяти. Пустые переменные выпадают, лишние пробелы убираются.
const { query } = require('../db');

const FIELDS = {
  model: 'Модель', cpu: 'Процессор', ram: 'ОЗУ', storage: 'Накопитель', os: 'ОС', hostname: 'Сетевое имя', mac_address: 'MAC-адрес',
};
const DEFAULT_FORMATS = {
  model: '{производитель} {модель}', cpu: '{название}', ram: '{объём} ГБ', storage: '{тип} {объём}', os: '{название}', hostname: '{имя}', mac_address: '{mac}',
};
// Переменные шаблонов: описание и пример — для страницы настроек
const VARS = {
  model: { производитель: 'Dell, HP, Lenovo…', модель: 'OptiPlex 7010 (у Lenovo — ThinkCentre M70q)', код: 'код модели от производителя (11JN0042RU)' },
  cpu: { название: 'Intel Core i5-12400', модель: 'i5-12400', производитель: 'Intel / AMD', ядра: '6', потоки: '12', ггц: '2,5' },
  ram: { объём: '16', тип: 'DDR4', частота: '3200', планок: '2', схема: '2×8' },
  storage: { тип: 'SSD / HDD', объём: '512 ГБ, 1 ТБ', гб: '512', модель: 'модель диска', интерфейс: 'NVMe / SATA', разделитель: '(в шаблоне не нужен — диски соединяются через « + »)' },
  os: { название: 'Windows 11 Pro', версия: '10.0.22631', сборка: '22631', разрядность: 'x64 / x86' },
  hostname: { имя: 'BUH-PC01', имя_мал: 'buh-pc01' },
  mac_address: { mac: 'B0:4F:13:11:22:33', mac_дефис: 'B0-4F-13-11-22-33', mac_слитно: 'B04F13112233' },
};

const MEM_TYPES = { 20: 'DDR', 21: 'DDR2', 22: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5', 35: 'DDR5' };
const fmtSize = (gb) => (gb >= 1000 && gb % 1000 === 0 ? `${gb / 1000} ТБ` : gb >= 1000 ? `${(gb / 1000).toFixed(1).replace('.', ',')} ТБ` : `${gb} ГБ`);
const generic = /system product name|to be filled|default string|^$/i;

/** Сведения из разделов опроса → переменные шаблонов по полям */
function facts(sections) {
  const pick = (x) => (x?.state === 'done' ? x.data : x?.previous?.data || null); // нет свежих данных — прошлые
  const w = pick(sections.wmi);
  const sn = pick(sections.snmp);
  const n = sections.network?.data;
  const f = {};
  if (w) {
    let maker = (w.manufacturer || '').replace(/,?\s*\b(Inc|Corporation|Corp|Co|Ltd|LLC|GmbH|Technology|Computer)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
    maker = { LENOVO: 'Lenovo', 'HEWLETT-PACKARD': 'HP', ASUSTEK: 'ASUS', 'MICRO-STAR INTERNATIONAL': 'MSI', 'GIGA-BYTE': 'Gigabyte' }[maker.toUpperCase()] || maker;
    let model = maker === 'Lenovo' && w.product_version && !generic.test(w.product_version) && !/^lenovo$/i.test(w.product_version) ? w.product_version : w.model;
    model = String(model || '').trim();
    if (maker && model.toLowerCase().startsWith(maker.toLowerCase().split(' ')[0] + ' ')) model = model.slice(maker.split(' ')[0].length).trim();
    if (model && !generic.test(model)) f.model = { производитель: maker, модель: model, код: w.model || '' };
    if (w.serial && !/to be filled|default string|^0+$|^none$/i.test(w.serial)) f.serial_number = w.serial;
    const c = w.cpu[0];
    if (c?.name) {
      const name = c.name.replace(/\((R|TM|tm)\)/g, '').replace(/^\s*\d+(st|nd|rd|th)\s+Gen\s+/i, '').replace(/\s+CPU\s+@.*$|\s+@.*$/i, '').replace(/\s+/g, ' ').trim();
      const vendor = /intel/i.test(name) ? 'Intel' : /amd/i.test(name) ? 'AMD' : '';
      const short = name.replace(/^(Intel|AMD)\s+/i, '').replace(/^Core\s+(?=i\d)/i, '').replace(/\s+with\s+.*$/i, '').replace(/\s+\d+-Core\s+Processor$|\s+Processor$/i, '').trim();
      const ghz = c.mhz ? (Math.round(c.mhz / 100) / 10).toString().replace('.', ',') : '';
      f.cpu = { название: name, модель: short, производитель: vendor, ядра: c.cores ?? '', потоки: c.threads ?? '', ггц: ghz };
    }
    const mods = w.memory_modules.filter((m) => Number(m.gb) > 0);
    const total = Math.round(mods.reduce((a, m) => a + Number(m.gb), 0) || Number(w.ram_gb) || 0);
    if (total) {
      const sizes = mods.map((m) => Math.round(Number(m.gb)));
      const same = sizes.length && sizes.every((x) => x === sizes[0]);
      f.ram = {
        объём: total, тип: MEM_TYPES[mods[0]?.type] || '', частота: mods[0]?.mhz || '', планок: mods.length || '',
        схема: !sizes.length ? '' : same ? `${sizes.length}×${sizes[0]}` : sizes.join('+'),
      };
    }
    const disks = w.disks.filter((x) => !x.usb && x.gb);
    if (disks.length) {
      f.storage = disks.map((x) => ({
        тип: x.kind || '', объём: fmtSize(x.gb), гб: x.gb, модель: x.model || '', интерфейс: x.bus === 17 ? 'NVMe' : x.iface === 'IDE' ? 'SATA' : x.iface || '',
      }));
    }
    if (w.os) {
      f.os = {
        название: w.os.replace(/^(Microsoft|Майкрософт)\s+/i, '').replace(/\s+/g, ' ').trim(),
        версия: w.os_version || '', сборка: w.os_build || '', разрядность: /64/.test(w.os_arch || '') ? 'x64' : w.os_arch ? 'x86' : '',
      };
    }
    if (w.hostname) f.hostname = w.hostname;
    const nic = w.nics.find((x) => n?.used_ip && String(x.ip).split(/,\s*/).includes(n.used_ip)) || w.nics[0];
    if (nic?.mac) f.mac = nic.mac;
  } else if (sn) {
    if (sn.model) f.model = { производитель: '', модель: sn.model, код: sn.model };
    if (sn.serial) f.serial_number = sn.serial;
  }
  if (n?.used_ip) f.ip_address = n.used_ip;
  if (!f.mac && n?.mac) f.mac = n.mac;
  return f;
}

/** Подставить переменные в шаблон */
function fill(tpl, vars) {
  return String(tpl || '').replace(/\{([^{}]+)\}/g, (_, k) => {
    const v = vars[k.trim()];
    return v === undefined || v === null ? '' : String(v);
  }).replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
}

/** Значения для карточки: { model, cpu, ram, storage, os, hostname, mac_address, serial_number, ip_address } */
function suggest(sections, opts = {}) {
  const fm = { ...DEFAULT_FORMATS, ...(opts.formats || {}) };
  const f = facts(sections);
  const out = {};
  if (f.model) out.model = fill(fm.model, f.model) || fill(DEFAULT_FORMATS.model, f.model);
  if (f.cpu) out.cpu = fill(fm.cpu, f.cpu);
  if (f.ram) out.ram = fill(fm.ram, f.ram);
  if (f.storage) out.storage = f.storage.map((d) => fill(fm.storage, d)).filter(Boolean).join(' + ');
  if (f.os) out.os = fill(fm.os, f.os);
  if (f.hostname) out.hostname = fill(fm.hostname, { имя: f.hostname, имя_мал: f.hostname.toLowerCase() });
  if (f.mac) {
    const hex = f.mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hex.length === 12) {
      const pairs = hex.match(/../g);
      out.mac_address = fill(fm.mac_address, { mac: pairs.join(':'), mac_дефис: pairs.join('-'), mac_слитно: hex });
    }
  }
  if (f.serial_number) out.serial_number = f.serial_number;
  if (f.ip_address) out.ip_address = f.ip_address;
  // Замены: точное совпадение (без учёта регистра) → значение, принятое в базе
  for (const r of opts.replacements || []) {
    const v = out[r.field];
    if (v && v.trim().toLowerCase() === r.src.trim().toLowerCase()) out[r.field] = r.dst;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/** Шаблоны и замены из базы */
async function loadFormatOpts() {
  const [s, r] = await Promise.all([
    query('SELECT formats FROM netprobe_settings WHERE id = 1'),
    query('SELECT id, field, src, dst FROM netprobe_replacements ORDER BY field, lower(src)'),
  ]);
  return { formats: s.rows[0]?.formats || {}, replacements: r.rows };
}

// Пример для предпросмотра шаблонов в настройках
const SAMPLE = {
  wmi: { state: 'done', data: {
    manufacturer: 'Dell Inc.', model: 'OptiPlex 7010', serial: 'DL7010-8841', hostname: 'BUH-PC01',
    cpu: [{ name: '12th Gen Intel(R) Core(TM) i5-12400', cores: 6, threads: 12, mhz: 2500 }],
    memory_modules: [{ gb: 8, mhz: 3200, type: 26 }, { gb: 8, mhz: 3200, type: 26 }], ram_gb: 15.7,
    disks: [{ model: 'Samsung SSD 980', gb: 512, kind: 'SSD', bus: 17, iface: 'SCSI' }, { model: 'WDC WD10EZEX', gb: 1000, kind: 'HDD', iface: 'IDE' }],
    os: 'Microsoft Windows 11 Pro', os_version: '10.0.22631', os_build: '22631', os_arch: '64-разрядная',
    nics: [{ mac: 'B0:4F:13:11:22:33', ip: '10.0.1.21' }],
  } },
  network: { state: 'done', data: { used_ip: '10.0.1.21' } },
};

module.exports = { FIELDS, DEFAULT_FORMATS, VARS, SAMPLE, facts, suggest, loadFormatOpts };
