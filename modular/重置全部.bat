@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
rem 重置鲸鲸：恢复出厂（清空 data\、config.json、微信库快照、日志），再用 config.example.json 重建
rem 具体逻辑在 scripts\factory-reset.ps1：停进程 -> 备份 -> 清空 -> 重建 -> 重启
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\factory-reset.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not defined WHALE_NO_PAUSE (
  echo 按任意键关闭这个窗口...
  pause >nul
)
exit /b %CODE%
