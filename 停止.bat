@echo off
rem ============================================================
rem  Log & Project Manager (LPM) - stop the local service (Windows)
rem  Kills whatever listens on port 3000 / 5174. Nothing else on your
rem  machine is touched. (Usually unnecessary: the service exits by
rem  itself 90 seconds after you close the web page.)
rem ============================================================
setlocal
title Stop LPM
echo.
echo   Stopping Log ^& Project Manager ...
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5174 " ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>&1
)

echo   Stopped.
timeout /t 3 /nobreak >nul
