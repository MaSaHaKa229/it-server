// Администрирование → «Состояние системы» → «Проверка возможностей Windows».
// Многое в портале работает через встроенные средства Windows (PowerShell, AD, WMI, arp, ping, подключение к сеансу),
// а у разработчика они не проверялись. Эта проверка пробует каждую возможность на сервере и пишет понятный итог —
// так проблема видна сразу, а не при первом использовании.
// Проверка идёт в фоне (WMI может отвечать до минуты), браузер опрашивает ход работы.
const os = require('os');
const express = require('express');
const { ah, HttpError } = require('../inventory/util');
const P = require('../inventory/netprobe/probes');
const PS = require('../inventory/netprobe/powershell');
const NP = require('../inventory/netprobe');

const router = express.Router();
let job = null; // { started_at, finished_at, target, checks: [{ ok, title, text, ms }], current }

const errText = (r) => NP.wmiError ? NP.wmiError(r.error) : r.error;

async function step(title, fn) {
  job.current = title;
  const t0 = Date.now();
  let res;
  try {
    res = await fn();
  } catch (e) {
    res = { ok: false, text: e.message };
  }
  job.checks.push({ title, ok: res.ok, text: res.text, ms: Date.now() - t0 });
}

async function runChecks(target) {
  const s = await NP.loadSettings({ withPassword: true });
  const fake = !!process.env.NETPROBE_FAKE_DIR;
  if (!P.IS_WIN && !fake) {
    job.checks.push({ title: 'Windows', ok: false, text: `Портал запущен не в Windows (${os.type()}) — проверять нечего`, ms: 0 });
    return;
  }

  // 1. PowerShell и учётная запись, под которой работает портал
  let self = null;
  await step('PowerShell', async () => {
    self = await PS.psSelfTest();
    if (self.error || !self.ok) return { ok: false, text: `PowerShell не запускается: ${self.error || 'нет ответа'}. Без него не работают AD, WMI и подключение к сеансу.` };
    return { ok: true, text: `Версия ${self.version}. Портал работает от имени ${self.user}${self.domain ? `, домен ${self.domain}` : ' (компьютер не в домене или учётная запись локальная)'}` };
  });

  // 2. Сетевые команды Windows: arp и ping (их вывод разбирается порталом — проверяем, что разбирается)
  await step('Команды arp и ping', async () => {
    const pg = await P.ping('127.0.0.1');
    const arp = await P.runFile(P.IS_WIN ? 'arp' : 'ip', P.IS_WIN ? ['-a'] : ['neigh'], { timeout: 8000 });
    const arpN = (String(arp.stdout || '').match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/gi) || []).length;
    if (!pg.alive) return { ok: 'warn', text: 'ping до самого сервера не прошёл или его ответ не распознан — сканирование сети в чужих подсетях может не находить устройства' };
    return { ok: arpN ? true : 'warn', text: `ping работает (ответ распознан)${arpN ? `, в таблице ARP ${arpN} адресов` : '; таблица ARP пуста — устройства своей подсети сканирование найдёт только по портам'}` };
  });

  // 3. Active Directory
  await step('Active Directory', async () => {
    if (!s.ad_enabled) return { ok: 'warn', text: 'Выключено в настройках «Сведения из сети»' };
    const name = target || (self && self.host) || os.hostname();
    const r = await PS.adLookup(s, name.split('.')[0], name.includes('.') ? name : '');
    if (r.error || r.ok === false) return { ok: false, text: `Нет доступа к AD: ${r.error}` };
    if (!r.found) return { ok: 'warn', text: `AD отвечает, но компьютер ${name} не найден (искали в: ${r.naming_context || '—'})${r.base_error ? `; ошибка места поиска из настроек: ${r.base_error}` : ''}` };
    return { ok: true, text: `Компьютер ${r.name} найден${r.os ? `, ${r.os}` : ''}${r.via === 'gc' ? ' (через глобальный каталог)' : ''}` };
  });

  // 4. WMI: обычный опрос (карточка техники) и пакетный (сканирование сети) — это разные скрипты
  if (!target) {
    job.checks.push({ title: 'WMI', ok: 'warn', text: 'Укажите имя компьютера сотрудника (включённого) — WMI проверяется на нём', ms: 0 });
  } else if (!s.wmi_enabled) {
    job.checks.push({ title: 'WMI', ok: 'warn', text: 'Выключено в настройках «Сведения из сети»', ms: 0 });
  } else {
    await step(`WMI: ${target} (карточка техники)`, async () => {
      const r = await PS.wmiCollect(s, target);
      if (r.error) return { ok: false, text: errText(r) };
      return { ok: true, text: `${[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}, ${r.os || '—'}, протокол ${r.protocol || '—'}` };
    });
    await step(`WMI: ${target} (сканирование сети)`, async () => {
      const m = await PS.wmiCollectMany(s, [target]);
      const r = m.get(target) || { error: 'нет ответа' };
      if (r.error) return { ok: false, text: errText(r) };
      return { ok: true, text: `Пакетный сбор работает: ${[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}` };
    });
    await step(`Установленное ПО: ${target}`, async () => {
      if (!PS.softwareCollect) return { ok: 'warn', text: 'нет в этой версии' };
      const r = await PS.softwareCollect(s, target);
      if (r.error) return { ok: false, text: errText(r) };
      return { ok: true, text: `Найдено программ: ${(r.items || []).length}` };
    });
  }

  // 5. Подключение к сеансу: нужные программы Windows
  await step('Подключение к сеансу', async () => {
    if (!P.IS_WIN) return { ok: 'warn', text: 'Проверяется только на Windows' };
    const found = [];
    const missing = [];
    for (const exe of ['qwinsta.exe', 'mstsc.exe', 'msra.exe']) {
      const r = await P.runFile('where.exe', [exe], { timeout: 5000 });
      (r.code === 0 && /\.exe/i.test(r.stdout) ? found : missing).push(exe);
    }
    return { ok: missing.includes('mstsc.exe') || missing.includes('qwinsta.exe') ? 'warn' : true,
      text: `${found.length ? `Есть: ${found.join(', ')}` : ''}${missing.length ? `${found.length ? '; ' : ''}нет на сервере: ${missing.join(', ')} (файл подключения запускается на компьютере сотрудника службы ИТ — там они нужнее)` : ''}` };
  });
}

router.post('/', ah(async (req, res) => {
  if (job && !job.finished_at) throw new HttpError(409, 'Проверка уже идёт');
  const target = String((req.body || {}).target || '').trim();
  if (target && !P.isHostname(target) && !P.isIPv4(target)) throw new HttpError(400, 'Имя компьютера: латиница, цифры, точка, дефис');
  job = { started_at: new Date().toISOString(), finished_at: null, target, checks: [], current: 'Подготовка' };
  const j = job;
  runChecks(target)
    .catch((e) => j.checks.push({ title: 'Ошибка проверки', ok: false, text: e.message, ms: 0 }))
    .finally(() => { j.finished_at = new Date().toISOString(); j.current = null; });
  res.status(202).json(j);
}));

router.get('/', (req, res) => res.json(job));

module.exports = router;
