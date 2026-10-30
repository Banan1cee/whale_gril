@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0.."

rem 优先用包里自带的 Python（解压即用，不用装）
set "PY=%~dp0..\runtime\python\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"

rem 本机代理没开时，残留的 HTTPS_PROXY 会让识别/模型请求连不上；模型和国内站点不需要代理
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

rem 连续失败计数：起来就退出超过 3 次就停下来，别每 3 秒重试刷屏
set "FAILS=0"

:loop
if exist "data\PAUSED" (
  timeout /t 5 /nobreak >nul
  goto loop
)

rem 每次启动前删掉就绪标记：进程在但没写这个文件 = 卡在初始化（不会监听）
if exist "data\bridge-ready.json" del /q "data\bridge-ready.json" >nul 2>&1

echo.
echo [%date% %time%] 启动微信桥接…
"%PY%" -u "examples\wechatauto_bridge.py"
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="0" (
  echo [%date% %time%] 桥接正常退出（code=0），不再自动重启。
  exit /b 0
)
if "%CODE%"=="1" (
  echo [%date% %time%] 桥接启动失败（code=1，缺依赖或缺 VC++ 运行库）。看 data\wechat-bridge-4x.log，修好再启动。
  exit /b 1
)
if "%CODE%"=="2" (
  echo [%date% %time%] 桥接提示配置/数据库问题（code=2，找不到数据库或打开数据库卡住）。按上面日志里的提示改，改完再启动。
  exit /b 2
)
if "%CODE%"=="7" (
  echo [%date% %time%] 桥接自己要求重启（code=7，发送卡住看门狗），3 秒后重启…
) else (
  echo [%date% %time%] 桥接异常退出（code=%CODE%）。负数如 -1073741819 是 0xC0000005 原生崩溃：微信窗口被回收/自更新时触发的访问违规，Python 拦不住。
  echo [%date% %time%] 3 秒后自动重启，不用手动干预。
)

if "%CODE%"=="7" goto retry
set /a FAILS+=1
if %FAILS% GEQ 4 (
  echo.
  echo [%date% %time%] 连着 %FAILS% 次起来就退出，先停在这里，避免无限重启刷屏。
  echo   1. 看 data\wechat-bridge-4x.log 最后几行
  echo   2. 常见原因：微信没登录 / 缺 VC++ 运行库 / 打开微信数据库卡住 / 微信正在更新
  echo   3. 修好后重新双击「启动微信桥接.bat」
  echo.
  pause
  exit /b 1
)

:retry
timeout /t 3 /nobreak >nul
goto loop
