@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
echo.
echo   查看已有记忆快照
echo.
"%NODE%" "%~dp0scripts\memory-tool.js" list
echo.
echo   要恢复某一份，把这行命令里的名字换掉（在 data\backups\ 里的文件名）：
echo     "%NODE%" scripts\memory-tool.js restore "data\backups\memory-20261026-220436-startup.json"
echo.
echo   或者直接把导出的 json 拖进来：
echo     "%NODE%" scripts\memory-tool.js restore "拖进来的文件路径.json"
echo.
pause >nul
exit /b 0