@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- whale-girl : UIA send self-test -------------------------------------
rem Close the "WeChat bridge" console window first, or the two programs
rem will fight over the same WeChat window.

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set WECHATAUTO_RHYTHM=off
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_XET=1
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=*

if not exist "%~dp0runtime\python\python.exe" (
  echo [ERROR] runtime\python\python.exe not found.
  echo Run this file from the whale-girl folder root.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  whale-girl : UIA send self-test
echo ============================================================
echo  What it does:
echo    1. list WeChat windows
echo    2. patch uia_compat, try to recognise the main window
echo    3. send ONE test message to "File Transfer" (yourself only)
echo    4. read the DB back to prove it really went out
echo.
echo  Please close the WeChat-bridge console window first.
echo ============================================================
echo.

"%~dp0runtime\python\python.exe" -u "%~dp0examples\uia_selftest.py"

echo.
echo ============================================================
echo  Done. Log file: data\uia-selftest.log
echo ============================================================
pause
