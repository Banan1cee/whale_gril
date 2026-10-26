@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
echo.
echo   备份鲸鲸的记忆（聊天记录 / 称呼 / 群设置）
echo.
"%NODE%" "%~dp0scripts\memory-tool.js" backup
if errorlevel 1 goto :fail
echo.
echo   备份在 data\backups\ 里。要导到别的地方（比如 U 盘），用：
echo     "%NODE%" scripts\memory-tool.js export "D:\鲸鲸记忆.json"
echo.
pause >nul
exit /b 0
:fail
echo.
echo   备份失败，看上面的报错。
pause >nul
exit /b 1