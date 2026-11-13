@echo off
rem Obnovlenie IT-portala: zapuskaet scripts\update-portal.ps1 (kopiya bazy, ostanovka, kopirovanie, zapusk)
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-portal.ps1" %*
if errorlevel 1 pause
