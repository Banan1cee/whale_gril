@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem 自愈：如果这个目录被打了「低完整性(Low)」标签，解压出来的 python.exe 会继承它，
rem 于是桥接以低权限运行 —— 看不到微信进程、改不了微信窗口，UIA 直接不可用
rem （日志表现：「未找到 Weixin.dll」「SetWindowPos 拒绝访问」「读不到会话列表」）。
rem 本 bat 由资源管理器双击启动，是 Medium 权限，有能力把标签修回 Medium。
rem 修不了也不影响下面照常启动（脚本里所有失败都静默）。
if exist "%~dp0scripts\fix-python-il.bat" call "%~dp0scripts\fix-python-il.bat" /quiet

rem 优先用包里自带的 Python（解压即用，不需要用户装）
set "PY=%~dp0runtime\python\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"

where python >nul 2>nul
if errorlevel 1 if /i "%PY%"=="python" (
  echo   [!] 没找到 Python，也没有 Python 运行环境。
  echo       装一下 Python 3.12: https://www.python.org/downloads/  （安装时勾选 Add to PATH）
  echo       装完再双击这个文件。
  pause
  exit /b 1
)

rem 本机代理没开时，残留的 HTTPS_PROXY 会让语音/识别请求连不上；模型和国内站点不需要代理
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

rem 手动启动 = 明确要跑，清掉「一键终止」留下的暂停标记
if exist "data\PAUSED" del /q "data\PAUSED" >nul 2>&1

echo.
echo   ==========================================
echo     Jingjing - WeChat 4.x bridge
echo   ==========================================
echo.
echo   Need: WeChat 4.x is running AND logged in.
echo   Need: whale server is running (launch the other bat first).
echo.
echo   Press Ctrl+C to stop.
echo.
echo   桥接会自动守护：万一微信长时间挂着时窗口被回收、桥接原生崩溃（code -1073741819），
echo   3 秒内自己拉起来，不用管它。
echo.
echo   ------------------------------ 启动日志 ------------------------------

rem 真正的循环守护在 scripts\bridge_loop.bat 里
call "%~dp0scripts\bridge_loop.bat"
set "CODE=%ERRORLEVEL%"
echo.
echo Bridge exited with code %CODE%.
echo Log file: data\wechat-bridge-4x.log
pause >nul
exit /b %CODE%