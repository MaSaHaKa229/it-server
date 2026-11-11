// Active Directory и WMI через встроенный в Windows PowerShell (как в NetMon).
// Имя компьютера, логин и пароль передаются через переменные окружения процесса,
// а не в тексте команды, — подставить в них команду невозможно, пароль не виден в списке процессов.
//
// Проверка без Windows: если задана переменная NETPROBE_FAKE_DIR, вместо PowerShell читаются файлы
// <папка>/<ad|wmi>-<ИМЯ>.json или <папка>/<ad|wmi>.json (ответ скрипта как есть).
const fs = require('fs');
const path = require('path');
const { runFile, IS_WIN } = require('./probes');

// Вывод в UTF-8, ошибки — в виде JSON
const PREFIX = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
`;

// ---------- Active Directory: один компьютер по имени ----------
const AD_SCRIPT = PREFIX + `
try {
  $srv=$env:NM_SERVER; $pfx= if($srv){"LDAP://$srv/"} else {"LDAP://"}
  function E($p){ if($env:NM_USER){ New-Object DirectoryServices.DirectoryEntry($p,$env:NM_USER,$env:NM_PASS) } else { New-Object DirectoryServices.DirectoryEntry($p) } }
  function X($s){ ($s -replace '\\\\','\\5c' -replace '\\*','\\2a' -replace '\\(','\\28' -replace '\\)','\\29' -replace [char]0,'') }
  $root=E ($pfx+'RootDSE')
  $def=[string]$root.Properties['defaultNamingContext'][0]
  $forest=[string]$root.Properties['rootDomainNamingContext'][0]
  $short=X $env:NM_NAME; $fqdn=X $env:NM_FQDN
  $f='(&(objectCategory=computer)(|(name='+$short+')(sAMAccountName='+$short+'$)'
  if($fqdn){ $f+='(dNSHostName='+$fqdn+')' }
  $f+='))'
  # Где искать по очереди: место из настроек, домен контроллера, глобальный каталог леса.
  # Ответ «A referral was returned» (компьютер или место поиска в другом домене) — переходим к следующему.
  $tries=@()
  if($env:NM_BASE){ $tries+=,@($pfx,$env:NM_BASE,'base') }
  if($def -and $def -ne $env:NM_BASE){ $tries+=,@($pfx,$def,'domain') }
  if($forest){ $gc= if($srv){"GC://$srv/"} else {'GC://'}; $tries+=,@($gc,$forest,'gc') }
  $r=$null; $nc=''; $via=''; $okAny=$false; $lastErr=''; $baseErr=''
  foreach($t in $tries){
    try {
      $ds=New-Object DirectoryServices.DirectorySearcher((E ($t[0]+$t[1])))
      $ds.Filter=$f; $ds.SizeLimit=2
      $ds.ReferralChasing=[DirectoryServices.ReferralChasingOption]::All
      foreach($a in 'name','dnshostname','operatingsystem','operatingsystemversion','operatingsystemservicepack','lastlogontimestamp','whencreated','whenchanged','pwdlastset','description','distinguishedname','useraccountcontrol','location','managedby','memberof'){ [void]$ds.PropertiesToLoad.Add($a) }
      $r=$ds.FindOne(); $okAny=$true
      if($r){ $nc=$t[1]; $via=$t[2]; break }
    } catch { $lastErr=$_.Exception.Message; if($t[2] -eq 'base'){ $baseErr=$lastErr } }
  }
  if(-not $r){
    if(-not $okAny){ @{ok=$false; error=$lastErr} | ConvertTo-Json -Compress; exit }
    @{ok=$true; found=$false; naming_context=($tries | ForEach-Object { $_[1] }) -join '; '; base_error=$baseErr} | ConvertTo-Json -Compress; exit
  }
  $pp=$r.Properties
  function G($n){ if($pp[$n].Count){ $pp[$n][0] } else { $null } }
  function FT($v){ if($v -and [int64]$v -gt 0){ [DateTime]::FromFileTime([int64]$v).ToString('s') } else { $null } }
  function DT($v){ if($v -is [datetime]){ $v.ToLocalTime().ToString('s') } else { $null } }
  $uac=[int](G 'useraccountcontrol')
  $groups=@($pp['memberof'] | ForEach-Object { ([string]$_) -replace '^CN=([^,]+).*','$1' })
  [ordered]@{ ok=$true; found=$true; naming_context=$nc; via=$via; base_error=$baseErr; configured_base=[string]$env:NM_BASE
    name=[string](G 'name'); dns=[string](G 'dnshostname'); os=[string](G 'operatingsystem')
    os_version=[string](G 'operatingsystemversion'); service_pack=[string](G 'operatingsystemservicepack')
    last_logon=FT (G 'lastlogontimestamp'); pwd_last_set=FT (G 'pwdlastset')
    created=DT (G 'whencreated'); changed=DT (G 'whenchanged')
    description=[string](G 'description'); dn=[string](G 'distinguishedname')
    disabled=[bool]($uac -band 2); is_dc=[bool]($uac -band 0x2000)
    location=[string](G 'location'); managed_by=(([string](G 'managedby')) -replace '^CN=([^,]+).*','$1')
    groups=$groups
  } | ConvertTo-Json -Depth 4 -Compress
} catch { @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
`;

// ---------- WMI/CIM: характеристики компьютера (WinRM, затем DCOM) ----------
const WMI_SCRIPT = PREFIX + `
$cn=$env:NM_TARGET; $cred=$null; $S=$null; $err=''; $proto_used=''
if($env:NM_USER){ $sec=ConvertTo-SecureString $env:NM_PASS -AsPlainText -Force; $cred=New-Object System.Management.Automation.PSCredential($env:NM_USER,$sec) }
foreach($proto in 'Wsman','Dcom'){
  try{ $o=New-CimSessionOption -Protocol $proto
       $a=@{ComputerName=$cn;SessionOption=$o;OperationTimeoutSec=25;ErrorAction='Stop'}
       if($cred){$a.Credential=$cred}
       $S=New-CimSession @a; $proto_used=$proto; break } catch { $err=$_.Exception.Message }
}
if(-not $S){ @{error="Не удалось подключиться ни по WinRM, ни по WMI (DCOM): $err"} | ConvertTo-Json -Compress; exit }
$p=@{CimSession=$S}
function Q($c,$f,$ns){ $a=@{ClassName=$c;ErrorAction='Stop'}; if($f){$a.Filter=$f}; if($ns){$a.Namespace=$ns}; try { Get-CimInstance @p @a } catch { $script:err=$_.Exception.Message; $null } }
function S($v){ if($null -eq $v){ '' } else { ("$v").Trim() } }
function D($v){ if($v -is [datetime]){ $v.ToString('s') } else { S $v } }
$os=Q 'Win32_OperatingSystem'; $cs=Q 'Win32_ComputerSystem'; $bios=Q 'Win32_BIOS'; $bb=Q 'Win32_BaseBoard'
if(-not $os -and -not $cs){ @{error="Нет доступа к WMI: $err"} | ConvertTo-Json -Compress; exit }
$cpu=@(Q 'Win32_Processor'); $mem=@(Q 'Win32_PhysicalMemory'); $ld=@(Q 'Win32_LogicalDisk' 'DriveType=3')
$dd=@(Q 'Win32_DiskDrive'); $gpu=@(Q 'Win32_VideoController'); $nic=@(Q 'Win32_NetworkAdapterConfiguration' 'IPEnabled=True')
$csp=Q 'Win32_ComputerSystemProduct'; $enc=Q 'Win32_SystemEnclosure'
$pd=@(Q 'MSFT_PhysicalDisk' $null 'root/Microsoft/Windows/Storage')
$r=[ordered]@{
 protocol=$proto_used
 hostname=S $cs.Name; domain=S $cs.Domain; part_of_domain=[bool]$cs.PartOfDomain
 manufacturer=S $cs.Manufacturer; model=S $cs.Model; user=S $cs.UserName
 os=S $os.Caption; os_version=S $os.Version; os_build=S $os.BuildNumber; os_arch=S $os.OSArchitecture
 install_date=D $os.InstallDate; last_boot=D $os.LastBootUpTime
 serial=S $bios.SerialNumber; uuid=S $csp.UUID; product_version=S $csp.Version; chassis=(@($enc.ChassisTypes) -join ',')
 bios=("{0} {1} {2}" -f (S $bios.Manufacturer),(S $bios.SMBIOSBIOSVersion),(D $bios.ReleaseDate)).Trim()
 board=("{0} {1}" -f (S $bb.Manufacturer),(S $bb.Product)).Trim()
 ram_gb=if($cs){[math]::Round($cs.TotalPhysicalMemory/1GB,1)}else{$null}
 ram_free_gb=if($os){[math]::Round($os.FreePhysicalMemory/1MB,1)}else{$null}
 cpu=@($cpu|%{ [ordered]@{name=S $_.Name; cores=$_.NumberOfCores; threads=$_.NumberOfLogicalProcessors; mhz=$_.MaxClockSpeed} })
 memory_modules=@($mem|%{ [ordered]@{slot=S $_.DeviceLocator; gb=[math]::Round($_.Capacity/1GB,1); mhz=$_.Speed; maker=S $_.Manufacturer; part=S $_.PartNumber} })
 disks=@($dd|%{ $d=$_; $m=$pd | Where-Object { (S $_.SerialNumber) -and (S $_.SerialNumber) -eq (S $d.SerialNumber) } | Select-Object -First 1
   [ordered]@{model=S $d.Model; bytes=[double]$d.Size; iface=S $d.InterfaceType; serial=S $d.SerialNumber; media=if($m){[int]$m.MediaType}else{$null}; bus=if($m){[int]$m.BusType}else{$null}} })
 volumes=@($ld|%{ [ordered]@{name=S $_.DeviceID; label=S $_.VolumeName; fs=S $_.FileSystem; size_gb=[math]::Round($_.Size/1GB,1); free_gb=[math]::Round($_.FreeSpace/1GB,1)} })
 gpu=@($gpu|%{ S $_.Name })
 nics=@($nic|%{ [ordered]@{name=S $_.Description; mac=S $_.MACAddress; ip=(@($_.IPAddress) -join ', '); dhcp=[bool]$_.DHCPEnabled} })
}
Remove-CimSession $S -ErrorAction SilentlyContinue
$r | ConvertTo-Json -Depth 4 -Compress
`;

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Первый JSON-объект из вывода PowerShell */
function parseJson(out) {
  const i = out.indexOf('{'), j = out.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(out.slice(i, j + 1)); } catch { return null; }
}

function fakeAnswer(kind, name) {
  const dir = process.env.NETPROBE_FAKE_DIR;
  for (const f of [`${kind}-${String(name).toUpperCase()}.json`, `${kind}.json`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return JSON.stringify({ error: 'Нет ответа (тестовый режим)' });
}

async function runPS(kind, script, vars, timeout) {
  if (process.env.NETPROBE_FAKE_DIR) {
    await new Promise((r) => setTimeout(r, Number(process.env.NETPROBE_FAKE_DELAY || 300)));
    return parseJson(fakeAnswer(kind, vars.NM_NAME || vars.NM_TARGET)) || { error: 'Неверный ответ' };
  }
  if (!IS_WIN) return { error: 'Сведения из Active Directory и WMI собираются только на сервере с Windows' };
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NM_/i.test(k)) env[k] = v;
  for (const [k, v] of Object.entries(vars)) if (v) env[k] = String(v);
  const r = await runFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
    { timeout, env, encoding: 'utf8' });
  if (r.killed) return { error: `Нет ответа за ${Math.round(timeout / 1000)} с` };
  const data = parseJson(r.stdout);
  if (data) return data;
  const msg = (r.stderr || r.stdout || `PowerShell завершился с кодом ${r.code}`).replace(/\s+/g, ' ').trim();
  return { error: msg.slice(0, 400) };
}

const credVars = (s) => (s.username ? { NM_USER: s.username, NM_PASS: s.password || '' } : {});

/** Компьютер в Active Directory. name — короткое имя (NetBIOS), fqdn — полное DNS-имя, если известно */
function adLookup(s, name, fqdn) {
  return runPS('ad', AD_SCRIPT, {
    NM_NAME: name, NM_FQDN: fqdn || '', NM_SERVER: s.ad_server, NM_BASE: s.ad_base_dn, ...credVars(s),
  }, 45000);
}

/** Характеристики компьютера по WMI */
function wmiCollect(s, target) {
  return runPS('wmi', WMI_SCRIPT, { NM_TARGET: target, ...credVars(s) }, 120000);
}

module.exports = { adLookup, wmiCollect };
