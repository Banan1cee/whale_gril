@echo off
chcp 65001 >nul 2>nul
rem ---------------------------------------------------------------------------
rem Self-heal: give runtime\python\python.exe / pythonw.exe a Medium integrity
rem label instead of Low.
rem
rem Why:
rem   The workspace folder (e.g. E:\deepseek_home) carries a "Low" mandatory
rem   label, so every exe extracted under it inherits Low. A Low python then:
rem     - cannot enumerate modules of the (Medium) WeChat process
rem       -> bridge logs "Weixin.dll not found", UIA tree is empty
rem     - fails SetWindowPos with error 5 (access denied)
rem     - is blocked by UIPI -> cannot type into the WeChat window
rem   Result: the bridge cannot recognise the account window and refuses to send.
rem
rem Usage:
rem   fix-python-il.bat           normal (prints the result, waits for a key)
rem   fix-python-il.bat /quiet    silent, used by the bridge launcher before start
rem
rem Needs to run from a Medium process (Explorer double-click / cmd). The
rem current user owns python.exe, so no admin rights are required; if it still
rem reports Low, right-click -> Run as administrator.
rem Keep this file ASCII-only and CRLF-terminated.
rem ---------------------------------------------------------------------------
setlocal
set "QUIET=0"
if /i "%~1"=="/quiet" set "QUIET=1"

set "RT=%~dp0..\runtime\python"
for %%F in ("%RT%\python.exe" "%RT%\pythonw.exe") do (
  if exist "%%~fF" (
    icacls "%%~fF" /grant:r "%USERDOMAIN%\%USERNAME%:(F)" >nul 2>&1
    icacls "%%~fF" /setintegritylevel Medium >nul 2>&1
  )
)

if "%QUIET%"=="1" (
  endlocal
  exit /b 0
)

echo.
echo   ==========================================
echo     Python integrity level fix
echo   ==========================================
echo.
if exist "%RT%\python.exe" (
  echo   [python.exe]
  icacls "%RT%\python.exe" | findstr /i "Mandatory"
) else (
  echo   runtime\python\python.exe not found - run the runtime installer first.
)
if exist "%RT%\pythonw.exe" (
  echo   [pythonw.exe]
  icacls "%RT%\pythonw.exe" | findstr /i "Mandatory"
)
echo.
echo   Expected: "Medium Mandatory Level".
echo   Still "Low"?  right-click this file - Run as administrator.
echo   After fixing, restart the WeChat bridge.
echo.
pause
endlocal
exit /b 0
