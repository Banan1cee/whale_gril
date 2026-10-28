@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\migrate-data.ps1" %*
if not "%~1"=="" exit /b %ERRORLEVEL%