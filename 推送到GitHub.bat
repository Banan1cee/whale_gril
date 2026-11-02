@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem 把这次的改动推到 GitHub：feat/launcher-icon-and-signpath
rem 第一次会弹浏览器让你登录 GitHub（授权一次，凭据存在 Windows 凭据管理器里，之后不用再登）
rem 推完去 https://github.com/Banan1cee/whale_gril/compare/main...feat/launcher-icon-and-signpath 开 PR

set "GIT=%LOCALAPPDATA%\PortableGit\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

echo   分支 / 待推的提交：
"%GIT%" log --oneline -1
echo.
"%GIT%" status --short
echo.

"%GIT%" push -u origin feat/launcher-icon-and-signpath
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo   ✓ 推上去了。下一步：开 PR 合并到 main，然后在仓库 Settings 里配 SIGNING_MODE
) else (
  echo   push 失败（退出码 %CODE%）。凭据弹窗关掉了？重跑一次；或者看上面的报错。
)
echo.
pause >nul
exit /b %CODE%
