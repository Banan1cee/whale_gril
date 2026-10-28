@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 一键诊断 UIA：把「UIA 不可用 / 发送很慢」变成一个明确结论
rem 只读检查，不会修改微信内存（--probe 会尝试一次热激活并计时）

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set WECHATAUTO_RHYTHM=off
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=*

if not exist "%~dp0runtime\python\python.exe" (
  echo [错误] 没找到 runtime\python\python.exe
  echo 请在「鲸鱼娘」文件夹根目录双击本文件。
  pause
  exit /b 1
)

"%~dp0runtime\python\python.exe" "%~dp0tools\uia-check.py"
echo.
pause
