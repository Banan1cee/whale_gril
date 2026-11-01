@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem 1) 便携运行时优先：发行包带了 ..\.dotnet10 就不碰系统、不联网
if exist "%~dp0..\.dotnet10\dotnet.exe" (
    for %%I in ("%~dp0..\.dotnet10") do set "DOTNET_ROOT=%%~fI"
    goto :launch
)

rem 2) 检测系统运行时；没有就用随包的安装包装（runtime\dotnet\，约 60MB）
rem    模型说明见 scripts\ensure-dotnet.ps1；这里 -Auto 不询问，缺了就装。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-dotnet.ps1" -Auto
if errorlevel 1 (
    echo.
    echo   启动器需要 .NET 10 桌面运行时，没有装成功。
    echo   手动下载：https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe
    echo.
    pause
    exit /b 1
)

:launch
echo 正在打开鲸鲸启动器...
echo 如果弹出 UAC，请点「是」。
echo 窗口打开后，点右上角的「启动」才会拉起内核和桥接。
echo.
start "" "%~dp0WhaleLauncher.exe"
