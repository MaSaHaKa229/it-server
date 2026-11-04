# Автозапуск ИТ-портала при загрузке Windows (через Планировщик заданий).
# Запуск: PowerShell от имени администратора ->  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source
$log  = Join-Path $root 'portal.log'
$taskName = 'IT Portal'

# Старое задание ИТ-инвентаря (если было с таким именем) лучше отключить вручную в Планировщике заданий.
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" server\index.js >> `"$log`" 2>&1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Задание '$taskName' создано и запущено. Журнал: $log"
Write-Host "Остановить:  Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "Удалить:     Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
