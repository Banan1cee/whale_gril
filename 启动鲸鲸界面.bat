@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem 这台机器没有系统级 .NET 10 时，用旁边的本地 SDK 运行；有系统运行时也可以直接跑。
if exist "%~dp0..\.dotnet10\dotnet.exe" (
    for %%I in ("%~dp0..\.dotnet10") do set "DOTNET_ROOT=%%~fI"
)

echo 正在打开鲸鲸启动器...
echo 如果弹出 UAC，请点「是」。
echo 窗口打开后，点右上角的「启动」才会拉起内核和桥接。
echo.

start "" "%~dp0WhaleLauncher.exe"