# Автозапуск nginx при загрузке Windows и открытие порта 80 в брандмауэре.
# Запуск: PowerShell от имени администратора ->
#   powershell -ExecutionPolicy Bypass -File scripts\install-nginx-autostart.ps1 [-NginxDir C:\nginx] [-ClosePortalPorts]
param(
  [string]$NginxDir = 'C:\nginx',
  [switch]$ClosePortalPorts   # убрать правила для 3000/3100 — заходить только через nginx
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $NginxDir 'nginx.exe'
if (-not (Test-Path $exe)) { throw "Не найден $exe. Укажите папку: -NginxDir D:\nginx" }

Push-Location $NginxDir
try {
  # Проверка конфигурации
  & $exe -t
  if ($LASTEXITCODE -ne 0) { throw 'Ошибка в conf\nginx.conf — исправьте и запустите снова' }
  # Если nginx уже запущен вручную — останавливаем, чтобы запустить из Планировщика
  if (Get-Process nginx -ErrorAction SilentlyContinue) { & $exe -s quit; Start-Sleep 2 }
} finally { Pop-Location }

$action    = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $NginxDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName 'nginx' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'nginx'

if (-not (Get-NetFirewallRule -DisplayName 'nginx (80)' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'nginx (80)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 | Out-Null
}
if ($ClosePortalPorts) {
  Remove-NetFirewallRule -DisplayName 'IT Portal (3000)' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'IT Helpdesk (3100)' -ErrorAction SilentlyContinue
  Write-Host 'Прямой доступ к портам 3000 и 3100 из сети закрыт.'
}
Write-Host "nginx запущен и будет стартовать вместе с Windows (задание 'nginx')."
Write-Host "Применить изменения конфигурации: cd $NginxDir; .\nginx.exe -s reload"
