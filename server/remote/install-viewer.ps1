# Удалённая установка программы специалиста «ИТ Удалённый доступ» (RemoteSupport) на компьютер в сети.
# Запускается порталом на сервере (server/remote/install.js), сотруднику за целевым компьютером ничего делать не нужно.
#
# Вход — JSON в stdin: { computer, user, password, server, downloads }
#   computer  — имя или IP компьютера специалиста
#   user      — учётная запись администратора этого компьютера (ДОМЕН\admin или .\Администратор)
#   password  — пароль (не сохраняется и не пишется в журнал)
#   server    — адрес портала, которому программа будет доверять
#   downloads — папка с ITRemoteViewer.exe и ITRemoteViewer-win7.exe
# Выход — по одной JSON-строке на событие: { step, state: run|ok|warn|fail, text, ... }
#
# Как работает: WMI (DCOM) — узнать версию Windows и запустить установку; общий ресурс C$ — скопировать файл.
# На компьютере специалиста должны быть разрешены в брандмауэре «Общий доступ к файлам и принтерам»
# и «Инструментарий управления Windows (WMI)» (в домене обычно включаются групповой политикой).
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Say([string]$step, [string]$state, [string]$text, $extra = $null) {
  $o = @{ step = $step; state = $state; text = $text }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# Понятный текст для частых ошибок
function Explain($err) {
  $m = "$($err.Exception.Message)"
  if ($m -match 'Access is denied|Отказано в доступе|0x80070005|E_ACCESSDENIED|logon failure|unknown user name|неизвестное имя пользователя') {
    return "Нет доступа: проверьте логин и пароль администратора компьютера. Для локальной (не доменной) учётной записи " +
           "удалённый доступ администратора в Windows по умолчанию ограничен — используйте доменного администратора. ($m)"
  }
  if ($m -match '0x800706BA|RPC server is unavailable|Сервер RPC недоступен|WinRM|cannot connect|не удается подключиться') {
    return "Компьютер не отвечает по WMI: он выключен, имя указано неверно или брандмауэр закрывает " +
           "«Инструментарий управления Windows (WMI)». ($m)"
  }
  if ($m -match 'network path|сетевой путь|network name|сетевое имя|0x80070035|0x80070043') {
    return "Нет доступа к общему ресурсу C`$: включите в брандмауэре компьютера «Общий доступ к файлам и принтерам». ($m)"
  }
  if ($m -match 'being used by another process|используется другим процессом') {
    return "Программа сейчас открыта на компьютере специалиста — попросите закрыть её и повторите установку. ($m)"
  }
  return $m
}

$cim = $null
$drive = $null
try {
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $computer = "$($p.computer)".Trim()
  if (-not $computer) { throw 'Не указан компьютер' }

  # 1. Подключение и версия Windows
  Say 'connect' 'run' "Подключение к $computer…"
  if ($DryRun) {
    Start-Sleep -Milliseconds 500
    $os = [pscustomobject]@{ Caption = 'Microsoft Windows 10 Pro (проверочный запуск)'; Version = '10.0.19045'; OSArchitecture = '64-bit'; SystemDrive = 'C:' }
    if ($computer -match '^win7') { $os.Caption = 'Microsoft Windows 7 Professional (проверочный запуск)'; $os.Version = '6.1.7601' }
    if ($computer -match '^offline') { throw 'Сервер RPC недоступен. (Exception from HRESULT: 0x800706BA)' }
  } else {
    $sec = ConvertTo-SecureString "$($p.password)" -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential("$($p.user)", $sec)
    $opt = New-CimSessionOption -Protocol Dcom
    $cim = New-CimSession -ComputerName $computer -Credential $cred -SessionOption $opt -OperationTimeoutSec 30
    $os = Get-CimInstance -CimSession $cim -ClassName Win32_OperatingSystem
  }
  $ver = [version]"$($os.Version)"
  $x64 = "$($os.OSArchitecture)" -match '64'
  Say 'connect' 'ok' "$($os.Caption), версия $($os.Version), $($os.OSArchitecture)" @{ os = "$($os.Caption) $($os.Version)" }
  if ($ver.Major -lt 6 -or ($ver.Major -eq 6 -and $ver.Minor -lt 1)) {
    throw 'Программа специалиста работает в Windows 7 и новее; Windows XP и Vista не поддерживаются.'
  }
  # Windows 7/8/8.1 и 32-битные системы — сборка на .NET 6 (x86); Windows 10/11 x64 — на .NET 8
  $legacy = ($ver.Major -eq 6) -or (-not $x64)
  $file = if ($legacy) { 'ITRemoteViewer-win7.exe' } else { 'ITRemoteViewer.exe' }
  $src = Join-Path "$($p.downloads)" $file
  if (-not (Test-Path -LiteralPath $src)) { throw "На сервере нет файла $file (папка public\remote\downloads). Установите полный архив обновления портала." }

  # 2. Копирование через административный общий ресурс
  $letter = "$($os.SystemDrive)".TrimEnd(':')
  if (-not $letter) { $letter = 'C' }
  Say 'copy' 'run' "Копирование $file в $($letter):\Program Files\ITRemote…"
  if ($DryRun) {
    Start-Sleep -Milliseconds 500
  } else {
    $root = "\\$computer\$letter`$"
    $drive = New-PSDrive -Name ITRSETUP -PSProvider FileSystem -Root $root -Credential $cred
    New-Item -ItemType Directory -Force -Path 'ITRSETUP:\Program Files\ITRemote' | Out-Null
    New-Item -ItemType Directory -Force -Path 'ITRSETUP:\ProgramData\ITRemote' | Out-Null
    Remove-Item -Force -ErrorAction SilentlyContinue 'ITRSETUP:\ProgramData\ITRemote\viewer-install.log'
    Copy-Item -LiteralPath $src -Destination 'ITRSETUP:\Program Files\ITRemote\ITRemoteViewer.exe' -Force
  }
  $size = [math]::Round((Get-Item -LiteralPath $src).Length / 1MB, 1)
  Say 'copy' 'ok' "Скопировано ($size МБ)"

  # 3. Запуск установки на компьютере (от имени администратора, без окна)
  Say 'setup' 'run' 'Настройка: ссылки из портала, ярлыки, «Программы и компоненты»…'
  $lines = @()
  if ($DryRun) {
    Start-Sleep -Milliseconds 500
    $lines = @('OK 0.3.0')
  } else {
    $exe = "$($letter):\Program Files\ITRemote\ITRemoteViewer.exe"
    $cmd = "`"$exe`" --install-machine --server $($p.server)"
    $r = Invoke-CimMethod -CimSession $cim -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    if ($r.ReturnValue -ne 0) { throw "Не удалось запустить программу на компьютере (код WMI $($r.ReturnValue))" }
    $procId = $r.ProcessId
    $deadline = (Get-Date).AddSeconds(180)
    do {
      Start-Sleep -Seconds 2
      $alive = Get-CimInstance -CimSession $cim -ClassName Win32_Process -Filter "ProcessId = $procId"
    } while ($alive -and (Get-Date) -lt $deadline)
    if ($alive) { throw 'Установка не завершилась за 3 минуты' }
    $log = 'ITRSETUP:\ProgramData\ITRemote\viewer-install.log'
    if (-not (Test-Path $log)) {
      if ($legacy) {
        throw 'Программа не запустилась на компьютере. Для Windows 7 нужны обновления KB2533623 и KB2999226 (Universal C Runtime) — установите их и повторите.'
      }
      throw 'Программа не запустилась на компьютере (нет журнала установки).'
    }
    $lines = @(Get-Content -LiteralPath $log -Encoding UTF8)
  }
  $first = "$($lines[0])".TrimStart([char]0xFEFF)
  if ($first -notlike 'OK*') { throw ("Ошибка установки на компьютере: " + ($first -replace '^ERROR\s*', '')) }
  foreach ($l in $lines) { if ("$l" -like 'WARN*') { Say 'setup' 'warn' ("$l" -replace '^WARN\s*', '') } }
  $version = ($first -replace '^OK\s*', '').Trim()
  Say 'setup' 'ok' "Установлена версия $version"
  Say 'done' 'ok' 'Готово: у специалиста на рабочем столе и в меню «Пуск» — ярлык «ИТ Удалённый доступ»; кнопка «Подключиться» на портале открывает программу.' @{ version = $version; file = $file }
  exit 0
} catch {
  Say 'error' 'fail' (Explain $_)
  exit 1
} finally {
  if ($drive) { Remove-PSDrive -Name ITRSETUP -ErrorAction SilentlyContinue }
  if ($cim) { Remove-CimSession $cim -ErrorAction SilentlyContinue }
}
