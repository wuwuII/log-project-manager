@echo off
rem ==================================================================
rem  Log & Project Manager (LPM) - start (Windows)
rem
rem  IMPORTANT - keep this file PURE ASCII, with CRLF line endings.
rem  cmd.exe reads .bat files with the system code page (GBK on a
rem  Chinese Windows). If this file is saved as UTF-8 with Chinese
rem  characters inside, cmd mis-parses it and every comment line
rem  fails as: "'xxx' is not recognized as an internal or external
rem  command". For the same reason the launcher script beside this
rem  file is named _lpm_start.js - DO NOT rename it back to Chinese.
rem
rem  What it does: hands over to _lpm_start.js, which starts the
rem  service with no console window and opens your browser.
rem  The service saves everything and exits by itself 90 seconds
rem  after you close the web page. To stop it right away, double
rem  click the Chinese-named stop .bat sitting in this folder.
rem ==================================================================
cd /d "%~dp0"

rem  Find Node: prefer the portable runtime shipped in the "node" folder
rem  (offline layout), otherwise use the Node.js installed on this PC.
set "NODE=%~dp0node\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
"%NODE%" "%~dp0_lpm_start.js"

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
echo   directory (offline layout), or install Node.js 18+ from
echo   https://nodejs.org/ and run this file again.
echo.
pause

:done
exit
