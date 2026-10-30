@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0.."
echo.
echo   === 第 1 步 / 共 2 步：启动鲸鲸服务 ===
echo.
echo   等这个窗口出现「服务已启动 http://127.0.0.1:8787」，
echo   再回来双击「2 再点这个 启动微信桥接.bat」。
echo.
call "%~dp0..\启动鲸鱼娘.bat"