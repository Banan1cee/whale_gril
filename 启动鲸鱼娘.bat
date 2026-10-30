@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%~1"=="" exit /b %CODE%
echo.
echo Whale girl went back to the deep sea. Press any key to close this window.
pause >nul
exit /b %CODE%