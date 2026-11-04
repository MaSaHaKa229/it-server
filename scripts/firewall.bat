@echo off
rem Открыть порты портала и сайта заявок в брандмауэре Windows.
rem Запускать от имени администратора.
chcp 65001 >nul
netsh advfirewall firewall add rule name="IT Portal (3000)" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="IT Helpdesk (3100)" dir=in action=allow protocol=TCP localport=3100
echo Готово.
pause
