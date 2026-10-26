@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-all.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
echo   按任意键关闭窗口
pause >nul
exit /b %CODE%
