@echo off
rem ==================================================================
rem  Log & Project Manager (LPM) - start (Windows)
rem  Note: messages are ASCII on purpose - cmd.exe + CJK batch files
rem        get mojibake when the file is UTF-8. Chinese docs: README.md
rem
rem  What it does: hands over to _无窗口启动.js, which starts the service
rem  with no console window and opens your browser automatically.
rem  The service saves everything and exits by itself 90 seconds after
rem  you close the web page. To stop it right away: run 停止.bat
rem ==================================================================
cd /d "%~dp0"

rem  Find Node: prefer the portable runtime shipped in the "node" folder
rem  (offline package), otherwise use the Node.js installed on this PC.
set "NODE=%~dp0node\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
"%NODE%" "%~dp0_无窗口启动.js"

rem  Wait a moment, then verify the service is really listening on 5174.
ping -n 4 127.0.0.1 >nul
netstat -ano | findstr ":5174 " | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto done

echo.
echo   [WARN] Service did not come up on port 5174.
echo   Please check the log in your TEMP folder: lpm_app.log
echo.

if "%NODE%"=="node" (
  echo   [HINT] If the log says "npm install" / "Cannot find module",
  echo          you still need to build the project first. See README.md
  echo.
)
pause
goto done

:nonode
echo.
echo   [ERROR] Node.js not found.
echo.
echo   Either put a portable Node runtime in the "node" folder of this
echo   directory (offline package layout), or install Node.js 18+ from
echo   https://nodejs.org/ and run this file again.
echo.
pause

:done
exit
