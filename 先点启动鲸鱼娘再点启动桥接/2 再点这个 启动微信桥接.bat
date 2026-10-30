@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0.."
echo.
echo   === 第 2 步 / 共 2 步：启动微信桥接 ===
echo.
echo   前提：微信 4.x 已经登录，并且第 1 步的服务窗口还开着。
echo   如果这里刷「请求鲸鲸失败 / 积极拒绝」，说明服务没起来，先回去跑第 1 步。
echo.
call "%~dp0..\启动微信桥接.bat"