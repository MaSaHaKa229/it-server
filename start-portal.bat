@echo off
rem Запуск ИТ-портала (порт 3000) и сайта заявок (порт 3100)
chcp 65001 >nul
cd /d "%~dp0"
node server\index.js
pause
