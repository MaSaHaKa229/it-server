# Обновление ИТ-портала одной кнопкой. Запускается файлом «ОБНОВИТЬ ПОРТАЛ.cmd» из распакованного архива.
#
# Что делает:
#   1. резервная копия базы (в папку копий портала);
#   2. остановка портала (задание «IT Portal» и процессы node портала);
#   3. старые папки server, public, scripts — в C:\it-portal\_before-update\<дата> (две последние сохраняются);
#   4. копирование новых файлов из архива (.env, node_modules, backups, portal.log не трогаются);
#   5. запуск портала и проверка, что он отвечает; если не запустился — предлагает вернуть прежнюю версию.
# Всё, что происходит, пишется в C:\it-portal\update.log.
param([string]$Target = 'C:\it-portal', [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$TaskName = 'IT Portal'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [OK] $text" 'Green' }
function Warn($text) { Say "  [!]  $text" 'Yellow' }
function Fail($text) { Say "  [X]  $text" 'Red' }
function Finish($code) {
  try { Stop-Transcript | Out-Null } catch { }
  Write-Host ''
  Read-Host 'Нажмите Enter, чтобы закрыть окно' | Out-Null
  exit $code
}

# Права администратора нужны, чтобы остановить и запустить задание Планировщика
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($Elevated) { Fail 'Не удалось получить права администратора.'; Read-Host 'Enter'; exit 1 }
  Say 'Нужны права администратора — Windows сейчас спросит разрешение…' 'Yellow'
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Target', "`"$Target`"", '-Elevated')
  } catch {
    Fail 'Без прав администратора обновить портал нельзя (запрос Windows отклонён).'
    Read-Host 'Нажмите Enter' | Out-Null
    exit 1
  }
  exit 0
}

try { Start-Transcript -Path (Join-Path $Target 'update.log') -Append | Out-Null } catch { }
Say ''
Say '=== Обновление ИТ-портала ===' 'Cyan'
Say "Откуда: $src"
Say "Куда:   $Target"
Say ''

# ---------- проверки перед началом ----------
$need = @('server\index.js', 'public\portal\index.html', 'public\shared\ui.js', 'public\inventory\index.html', 'public\docs\index.html',
  'public\calendar\index.html', 'public\helpdesk\index.html', 'public\helpdesk-staff\index.html', 'package.json')
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $src $_)) })
if ($missing.Count) {
  Fail "В распакованном архиве не хватает файлов: $($missing -join ', ')"
  Say '     Распакуйте архив заново целиком и запустите «ОБНОВИТЬ ПОРТАЛ.cmd» из папки it-portal.'
  Finish 1
}
if (-not (Test-Path (Join-Path $Target '.env'))) {
  Fail "В $Target нет файла .env — это не папка установленного портала."
  Say '     Если портал установлен в другую папку, запустите из PowerShell:'
  Say "     powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Target D:\путь\к\порталу"
  Finish 1
}
if ((Resolve-Path $src).Path.TrimEnd('\') -ieq (Resolve-Path $Target).Path.TrimEnd('\')) {
  Fail 'Архив распакован прямо в папку портала. Распакуйте его в другое место (например, на Рабочий стол) и запустите снова.'
  Finish 1
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Не найден node.exe (Node.js). Портал без него не работает.'; Finish 1 }

# Порт портала — из .env
$port = 3000
foreach ($line in Get-Content (Join-Path $Target '.env')) { if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] } }

# ---------- 1. резервная копия ----------
Say '1. Резервная копия базы…' 'Cyan'
$env:NODE_PATH = Join-Path $Target 'node_modules'
# В Windows PowerShell 5.1 вывод ошибок программы при 2>&1 с ErrorActionPreference=Stop прервал бы сценарий
$ErrorActionPreference = 'Continue'
$out = & $node.Source (Join-Path $src 'server\tools\backup-now.js') --root $Target 2>&1 | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -eq 0 -and $out -match 'OK (\S+)') {
  Ok "Копия создана: $($Matches[1])"
} else {
  Warn "Копию сделать не удалось: $($out.Trim())"
  $ans = Read-Host '     Продолжить обновление без копии? Введите ДА, чтобы продолжить'
  if ($ans -ne 'ДА' -and $ans -ne 'да') { Say 'Обновление отменено, ничего не изменено.'; Finish 1 }
}

# ---------- 2. остановка портала ----------
Say '2. Остановка портала…' 'Cyan'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
function PortalProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -match 'server[\\/]index\.js' -or $_.CommandLine -match [regex]::Escape($Target) })
}
for ($i = 0; $i -lt 10; $i++) {
  $p = PortalProcesses
  if (-not $p.Count) { break }
  foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
if ((PortalProcesses).Count) { Fail 'Портал не остановился. Закройте окна портала (start-portal.bat) и запустите обновление снова.'; Finish 1 }
Start-Sleep -Seconds 1
Ok 'Портал остановлен'

# ---------- 3. прежняя версия — в сторону ----------
Say '3. Сохранение прежней версии…' 'Cyan'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$keepRoot = Join-Path $Target '_before-update'
$keep = Join-Path $keepRoot $stamp
New-Item -ItemType Directory -Path $keep -Force | Out-Null
$dirs = @('server', 'public', 'scripts')
$files = @('package.json', 'package-lock.json', 'start-portal.bat', 'README.md', 'INSTALL.md', '.env.example')
function Restore-Old {
  foreach ($d in $dirs) {
    $now = Join-Path $Target $d
    if (Test-Path (Join-Path $keep $d)) {
      if (Test-Path $now) { Remove-Item $now -Recurse -Force }
      Move-Item (Join-Path $keep $d) $now
    }
  }
  foreach ($f in $files) { if (Test-Path (Join-Path $keep $f)) { Copy-Item (Join-Path $keep $f) (Join-Path $Target $f) -Force } }
}
try {
  foreach ($d in $dirs) { if (Test-Path (Join-Path $Target $d)) { Move-Item (Join-Path $Target $d) (Join-Path $keep $d) } }
  foreach ($f in $files) { if (Test-Path (Join-Path $Target $f)) { Copy-Item (Join-Path $Target $f) (Join-Path $keep $f) -Force } }
} catch {
  Fail "Не удалось перенести старые папки: $($_.Exception.Message)"
  Say '     Возможно, какой-то файл открыт (например, в Проводнике или редакторе). Возвращаю как было…'
  Restore-Old
  if ($task) { Start-ScheduledTask -TaskName $TaskName }
  Finish 1
}
Ok "Прежняя версия: $keep"
# Хранить две последние
Get-ChildItem $keepRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# ---------- 4. новые файлы ----------
Say '4. Копирование новых файлов…' 'Cyan'
$copyOk = $true
foreach ($d in $dirs) {
  $ErrorActionPreference = 'Continue'
  & robocopy (Join-Path $src $d) (Join-Path $Target $d) /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($rc -ge 8) { Fail "Ошибка копирования папки $d (код robocopy $rc)"; $copyOk = $false }
}
foreach ($f in $files) { if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $Target $f) -Force } }
$pub = @('portal', 'shared', 'inventory', 'docs', 'calendar', 'helpdesk-staff', 'helpdesk')
$lost = @($pub | Where-Object { -not (Test-Path (Join-Path $Target "public\$_")) })
if ($lost.Count) { Fail "После копирования нет папок public: $($lost -join ', ')"; $copyOk = $false }
if (-not $copyOk) {
  Say '     Возвращаю прежнюю версию…' 'Yellow'
  Restore-Old
  if ($task) { Start-ScheduledTask -TaskName $TaskName }
  Finish 1
}
Ok 'Файлы скопированы'

# ---------- 5. запуск и проверка ----------
Say '5. Запуск портала…' 'Cyan'
$log = Join-Path $Target 'portal.log'
$logStart = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
if ($task) {
  Start-ScheduledTask -TaskName $TaskName
} else {
  Warn "Задание «$TaskName» не найдено — запускаю окном start-portal.bat"
  Start-Process -FilePath (Join-Path $Target 'start-portal.bat') -WorkingDirectory $Target
}
$up = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/login" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
  Write-Host -NoNewline '.'
}
Write-Host ''
$tail = ''
if (Test-Path $log) {
  try {
    $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($logStart, 'Begin') | Out-Null
    $tail = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd(); $fs.Close()
  } catch { }
}
if ($up) {
  Ok "Портал запущен: http://localhost:$port"
  if ($tail -match 'ВНИМАНИЕ') { Warn 'В журнале запуска есть предупреждения — посмотрите portal.log' }
  Say ''
  Say 'Готово. Откройте портал в браузере и проверьте Администрирование → «Состояние системы».' 'Green'
  Say "Прежняя версия сохранена в $keep — её можно удалить, если всё работает."
  Finish 0
}

Fail 'Портал не запустился за 3 минуты.'
if ($tail) { Say '     Последние строки журнала:'; ($tail -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 15) | ForEach-Object { Say "       $_" } }
$ans = Read-Host '     Вернуть прежнюю версию? Введите ДА'
if ($ans -eq 'ДА' -or $ans -eq 'да') {
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  foreach ($x in (PortalProcesses)) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Restore-Old
  if ($task) { Start-ScheduledTask -TaskName $TaskName }
  Say 'Прежняя версия возвращена и запущена. Пришлите файлы portal.log и update.log разработчику.' 'Yellow'
} else {
  Say 'Новая версия оставлена. Пришлите файлы portal.log и update.log разработчику.' 'Yellow'
}
Finish 1
