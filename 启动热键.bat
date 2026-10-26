@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "PY=%~dp0runtime\python\pythonw.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe"
if not exist "%PY%" set "PY=pythonw"
start "" "%PY%" "%~dp0tools\hotkey_daemon.py"