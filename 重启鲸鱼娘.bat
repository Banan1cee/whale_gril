@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo.
echo   ==========================================
echo     Restarting Jingjing server...
echo   ==========================================
echo.

rem kill old server listening on 8787 (kills its console window too)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":8787 .*LISTENING"') do (
  echo   stopping old server pid %%a
  taskkill /PID %%a /T /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*