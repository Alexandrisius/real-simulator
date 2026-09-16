@echo off
setlocal
chcp 65001 >nul
title Real Simulator - server (keep this window open)
cd /d "%~dp0"

REM The visible server window: live output here + tee to data\server.log.
REM Launched by start.bat, but can be run directly.
REM Keep config in sync with start.bat (port and database).

set "PORT=3999"
set "NODE_USE_SYSTEM_CA=1"


echo ============================================================
echo  Real Simulator: http://localhost:%PORT%
echo.
echo  This window IS the server. Live output is shown here.
echo  Minimize it if you like. Do NOT close it while working:
echo  closing stops the server.
echo  Proper way to stop: start.bat stop  (menu option 2).
echo  Everything shown here is also written to data\server.log
echo ============================================================
echo.

REM UTF-8 log writer: streams lines to console and to data/server.log
call npm start 2>&1 | powershell -NoProfile -Command "$f=[IO.File]::AppendText('data/server.log'); $f.AutoFlush=$true; $input | ForEach-Object { $_; $f.WriteLine($_) }; $f.Close()"

echo.
echo ============================================================
echo  Server stopped. If that was not intentional, the reason
echo  is a few lines above; full log: data\server.log
echo  This window closes itself in 10 seconds.
echo ============================================================
ping -n 11 127.0.0.1 >nul
