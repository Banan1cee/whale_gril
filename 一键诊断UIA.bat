@echo off
chcp 65001 >nul 2>nul
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

rem 和启动微信桥接.bat 一样的解释器顺序：包里的 runtime 优先
set "PY=%~dp0runtime\python\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"

if not exist "%PY%" (
  echo [错误] 没找到 Python 运行环境。
  echo 先双击「一键装运行环境.bat」，或在「鲸鱼娘」文件夹根目录运行本文件。
  pause
  exit /b 1
)

"%PY%" -u "%~dp0tools\uia-check.py"
echo.
pause
exit /b %ERRORLEVEL%
