// Подключение к сеансу пользователя (теневое подключение RDP) из карточки техники.
// Сайт не может сам запустить программу на компьютере, поэтому кнопка скачивает небольшой файл .cmd:
// он находит номер сеанса вошедшего пользователя (qwinsta) и запускает mstsc /shadow — пользователь не выходит из системы.
// Если сеансы получить не удалось (например, Windows XP), предлагает «Удалённый помощник» (msra /offerRA)
// или обычное подключение RDP. Включается/выключается администратором портала (netprobe_settings.remote_connect).

const DEFAULTS = { enabled: true, control: true, consent: true };

const settingsOf = (s) => ({ ...DEFAULTS, ...((s && s.remote_connect) || {}) });

/** Текст сценария PowerShell (передаётся в .cmd закодированным — так не мешают кавычки и кириллица) */
function psScript(target, opt) {
  const pc = String(target).replace(/'/g, "''");
  const mode = [opt.control ? '/control' : '', opt.consent ? '' : '/noConsentPrompt'].filter(Boolean).join(' ');
  return `
$pc = '${pc}'
$Host.UI.RawUI.WindowTitle = "Подключение к $pc"
Write-Host "Подключение к сеансу пользователя на компьютере $pc ..."
$out = & qwinsta /server:$pc 2>$null
$list = @()
foreach ($l in $out) {
  if ($l -match '^\\s*>?(console|rdp-tcp#\\d+)\\s+(\\S+)\\s+(\\d+)\\s') { $list += [pscustomobject]@{ Name = $Matches[1]; User = $Matches[2]; Id = $Matches[3] } }
}
if ($list.Count -gt 0) {
  $s = $list | Where-Object { $_.Name -eq 'console' } | Select-Object -First 1
  if (-not $s) { $s = $list[0] }
  if ($list.Count -gt 1) {
    Write-Host "На компьютере несколько сеансов:"
    $i = 1; foreach ($x in $list) { Write-Host ("  {0}. {1} ({2}, сеанс {3})" -f $i, $x.User, $x.Name, $x.Id); $i++ }
    $n = Read-Host "Номер сеанса [Enter - $($s.User)]"
    if ($n -match '^\\d+$' -and [int]$n -ge 1 -and [int]$n -le $list.Count) { $s = $list[[int]$n - 1] }
  }
  Write-Host "Пользователь: $($s.User), сеанс $($s.Id). ${opt.consent ? 'Пользователю будет показан запрос на подключение.' : ''}"
  Start-Process mstsc -ArgumentList "/shadow:$($s.Id) /v:$pc ${mode}"
  Start-Sleep -Seconds 2
  exit
}
Write-Host ""
Write-Host "Не удалось получить список сеансов (компьютер выключен, Windows XP/Home или не настроен доступ)."
Write-Host "  1 - Удалённый помощник (пользователь увидит запрос; работает и на Windows XP)"
Write-Host "  2 - Обычное подключение RDP (пользователь выйдет из системы)"
Write-Host "  Enter - отмена"
$c = Read-Host "Выберите"
if ($c -eq '1') { Start-Process msra -ArgumentList "/offerRA $pc" }
elseif ($c -eq '2') { Start-Process mstsc -ArgumentList "/v:$pc" }
`;
}

/** Файл .cmd для скачивания (CRLF; команда закодирована в Base64 UTF-16LE для powershell -EncodedCommand) */
function cmdFile(target, s) {
  const opt = settingsOf(s);
  const enc = Buffer.from(psScript(target, opt), 'utf16le').toString('base64');
  return [
    '@echo off',
    `rem IT-portal: connect to user session on ${String(target).replace(/[^\w.-]/g, '')}`,
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${enc}`,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
}

module.exports = { DEFAULTS, settingsOf, cmdFile, psScript };
