@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
echo.
echo   这个脚本会下载 Node 22 和 Python 3.12 到 runtime 目录（约 50MB），
echo   然后装微信桥接的依赖。以后就不用再装了。
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-runtime.ps1"
set "CODE=%ERRORLEVEL%"
if not "%~1"=="" exit /b %CODE%
echo.
echo Done. Exit code %CODE%
pause >nul
exit /b %CODE%