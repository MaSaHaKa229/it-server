// Настройки «Сведений из сети» — только администратор портала
import { h, clear, api, toast, run, fmtDate } from '../ui.js';
import { SECTIONS, renderSection } from './netinfo.js';

export async function renderNetprobeSettings(box) {
  const { settings: s, platform } = await api.get('/api/netinfo/settings');

  const username = h('input', { type: 'text', value: s.username, placeholder: 'CORP\\svc-inventory', autocomplete: 'off' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.has_password ? 'Сохранён — оставьте пустым, чтобы не менять' : 'Пароль учётной записи' });
  const adEnabled = h('input', { type: 'checkbox', checked: s.ad_enabled });
  const adServer = h('input', { type: 'text', value: s.ad_server, placeholder: 'Необязательно, например dc01.corp.local' });
  const adBase = h('input', { type: 'text', value: s.ad_base_dn, placeholder: 'Необязательно, например DC=corp,DC=local' });
  const wmiEnabled = h('input', { type: 'checkbox', checked: s.wmi_enabled });
  const snmpEnabled = h('input', { type: 'checkbox', checked: s.snmp_enabled });
  const snmpComm = h('input', { type: 'text', value: s.snmp_communities, placeholder: 'public' });
  let clearPassword = false;

  const save = h('button.btn.primary', 'Сохранить');
  save.addEventListener('click', () => run(async () => {
    const body = {
      username: username.value.trim(), ad_enabled: adEnabled.checked, ad_server: adServer.value.trim(), ad_base_dn: adBase.value.trim(),
      wmi_enabled: wmiEnabled.checked, snmp_enabled: snmpEnabled.checked, snmp_communities: snmpComm.value.trim() || 'public',
    };
    if (password.value) body.password = password.value;
    if (clearPassword) body.clear_password = true;
    await api.put('/api/netinfo/settings', body);
    toast('Настройки сохранены');
    renderNetprobeSettings(box);
  }, save));

  const pwState = s.has_password
    ? h('div.hint', 'Пароль сохранён (в базе — в зашифрованном виде). ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); clearPassword = true; password.placeholder = 'Пароль будет удалён при сохранении'; e.target.remove(); } }, 'Удалить пароль'))
    : h('div.hint', 'Пароль хранится в базе в зашифрованном виде и не показывается в браузере.');

  // ---------- Проверка на одном компьютере ----------
  const target = h('input', { type: 'text', placeholder: 'Сетевое имя или IP, например BUH-PC01' });
  const kind = h('select', h('option', { value: 'computer' }, 'Компьютер'), h('option', { value: 'printer' }, 'Принтер / МФУ'));
  const testBtn = h('button.btn', 'Проверить');
  const result = h('div.np-result');
  let timer = null;
  const poll = async (key) => {
    const { job } = await api.get('/api/netinfo/test?key=' + encodeURIComponent(key));
    clear(result, Object.entries(SECTIONS).map(([k, label]) => h('div.np-sec', h('h3', label), renderSection(k, job.sections[k]))));
    if (!job.done) timer = setTimeout(() => poll(key).catch((e) => toast(e.message, 'err')), 1500);
    else testBtn.disabled = false;
  };
  testBtn.addEventListener('click', () => run(async () => {
    if (!target.value.trim()) return toast('Укажите имя или IP компьютера', 'err');
    clearTimeout(timer);
    const r = await api.post('/api/netinfo/test', { target: target.value.trim(), kind: kind.value });
    testBtn.disabled = true;
    await poll(r.key);
  }, testBtn));
  target.addEventListener('keydown', (e) => { if (e.key === 'Enter') testBtn.click(); });

  clear(box,
    h('div.page-head', h('h2', 'Сведения из сети')),
    h('p.muted', { style: { marginTop: '-8px' } },
      'В карточке техники с сетевым именем или IP редакторы видят кнопку «Сведения из сети»: данные из Active Directory, ',
      'характеристики компьютера по WMI, сведения принтеров по SNMP и сетевые проверки. Здесь указывается, от чьего имени опрашивать.'),
    platform !== 'windows' ? h('div.np-warn', 'Портал сейчас работает не на Windows — Active Directory и WMI опрашиваться не будут, только сеть и SNMP.') : null,

    h('div.np-box',
      h('h3', 'Учётная запись'),
      h('div.form-grid',
        h('label.field', h('span', 'Логин'), username, h('div.hint', 'Доменная учётная запись с правами администратора на рабочих станциях: ДОМЕН\\логин или логин@домен.')),
        h('label.field', h('span', 'Пароль'), password, pwState)),
      h('div.hint', 'Если логин не указан, опрос идёт от имени, под которым запущен портал (обычно это «Система» — её прав для WMI не хватит).')),

    h('div.np-box',
      h('h3', h('label.check', adEnabled, 'Active Directory')),
      h('div.form-grid',
        h('label.field', h('span', 'Контроллер домена'), adServer, h('div.hint', 'Можно не заполнять: сервер портала в домене найдёт его сам.')),
        h('label.field', h('span', 'Где искать (корневой DN)'), adBase, h('div.hint', 'Можно не заполнять — весь домен.')))),

    h('div.np-box',
      h('h3', h('label.check', wmiEnabled, 'Характеристики компьютеров (WMI)')),
      h('p.hint', 'На рабочих станциях должен быть разрешён удалённый доступ — групповой политикой: «Компоненты Windows → Удалённое управление Windows → ',
        'Служба WinRM → Разрешить удалённое управление» и правило брандмауэра «Удалённое управление Windows (HTTP-входящий трафик)»; ',
        'или правило брандмауэра «Инструментарий управления Windows (WMI-входящий трафик)». Если программа NetMon у вас получает характеристики ПК — всё уже настроено.')),

    h('div.np-box',
      h('h3', h('label.check', snmpEnabled, 'Принтеры и МФУ (SNMP)')),
      h('label.field', { style: { maxWidth: '360px' } }, h('span', 'Сообщества SNMP'), snmpComm, h('div.hint', 'Через запятую; обычно public.'))),

    h('div.row', { style: { gap: '8px', alignItems: 'center' } }, save,
      s.updated_at ? h('span.muted.small', `Изменено ${fmtDate(s.updated_at)}`) : null),

    h('div.np-box', { style: { marginTop: '24px' } },
      h('h3', 'Проверка'),
      h('p.hint', 'Сохраните настройки и проверьте на любом компьютере или принтере — станет видно, что получается, а что нет и почему.'),
      h('div.np-test', target, kind, testBtn),
      result));
}
