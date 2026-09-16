@echo off
setlocal
title Real Simulator - server manager
cd /d "%~dp0"

REM ============================================================
REM  Real Simulator production server manager (ASCII-only on
REM  purpose: readable in any console codepage).
REM  No arguments = interactive menu, or commands:
REM    start.bat start | stop | restart | status | log | build
REM  Do not auto-open browser:  set SIM_NO_BROWSER=1
REM ============================================================

set "PORT=3999"
set "URL=http://localhost:%PORT%"
set "DB=data\app.db"
set "LOG=data\server.log"

set "NODE_USE_SYSTEM_CA=1"


set "CMD=%~1"
if "%CMD%"=="" goto :menu_loop
if /i "%CMD%"=="start"   (call :do_start & exit /b)
if /i "%CMD%"=="stop"    (call :do_stop & exit /b)
if /i "%CMD%"=="restart" (call :do_restart & exit /b)
if /i "%CMD%"=="status"  (call :do_status & exit /b)
if /i "%CMD%"=="log"     (call :do_log & exit /b)
if /i "%CMD%"=="build"   (call :do_build & exit /b)
if /i "%CMD%"=="help"    goto :usage
if /i "%CMD%"=="/?"      goto :usage
echo Unknown command: %CMD%
:usage
echo Usage: start.bat [start^|stop^|restart^|status^|log^|build^|help]
echo Without arguments an interactive menu opens.
exit /b 1

REM ---------------- Menu ----------------
:menu_loop
cls
call :status_line
echo.
echo    [1] Start server
echo    [2] Stop server
echo    [3] Restart
echo    [4] Detailed status
echo    [5] Logs - last 60 lines
echo    [6] Rebuild production bundle
echo    [0] Exit
echo.
set "opt="
set /p "opt=Select: "
if "%opt%"=="1" (call :do_start   & echo. & pause & goto :menu_loop)
if "%opt%"=="2" (call :do_stop    & echo. & pause & goto :menu_loop)
if "%opt%"=="3" (call :do_restart & echo. & pause & goto :menu_loop)
if "%opt%"=="4" (call :do_status  & echo. & pause & goto :menu_loop)
if "%opt%"=="5" (call :do_log     & echo. & pause & goto :menu_loop)
if "%opt%"=="6" (call :do_build   & echo. & pause & goto :menu_loop)
if "%opt%"=="0" exit /b 0
goto :menu_loop

REM ---------------- Helpers ----------------

REM PID listening on PORT. Empty = server is not running.
:findpid
set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do (
  if not defined PID set "PID=%%a"
)
exit /b 0

REM Health API status code: 200 = alive, 000 = unreachable.
:health
set "CODE=000"
for /f %%c in ('curl -s -m 2 -o nul -w "%%{http_code}" "%URL%/api/stats"') do set "CODE=%%c"
exit /b 0

REM ~2 second delay that works even with redirected stdin
REM (unlike "timeout" which fails there).
:sleep2
ping -n 3 127.0.0.1 >nul
exit /b 0

:status_line
call :findpid
call :health
if defined PID (set "ST=RUNNING, PID %PID%") else set "ST=stopped"
echo Server: %ST%  ^|  %URL%  ^|  API: %CODE%
if not exist ".next\BUILD_ID" echo WARNING: no production build - it will be rebuilt on start.
exit /b 0

REM ---------------- Commands ----------------

:do_start
call :findpid
if defined PID (
  echo Server is already running - PID %PID%. Opening browser.
  if not defined SIM_NO_BROWSER start "" %URL%
  exit /b 0
)
if not exist ".next\BUILD_ID" (
  echo No production build found - building now, takes 1-2 minutes.
  call :do_build
  if errorlevel 1 exit /b 1
)
if not exist "data" mkdir data
echo %date% %time% --- server start >> "%LOG%"
REM Detach via PowerShell Start-Process: the new window inherits NO handles.
REM Plain "start" leaks the parent stdout handle, so a caller piped into
REM tail/tee hangs forever even though the server actually started.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0server-run.cmd' -WorkingDirectory '%~dp0'" >nul 2>&1
if errorlevel 1 (
  echo Failed to launch the server window - run server-run.cmd manually.
  exit /b 1
)
echo Starting server on port %PORT%, waiting for API
set /a TRIES=0
:wait_loop
call :health
if "%CODE%"=="200" goto :started_ok
set /a TRIES+=1
if %TRIES% geq 40 (
  echo.
  echo API did not answer within ~80 seconds. Last log lines:
  call :do_log
  echo.
  echo Possible cause: port is busy. Run: start.bat stop  then  start.bat start
  exit /b 1
)
<nul set /p=.
call :sleep2
goto :wait_loop
:started_ok
echo.
call :findpid
echo OK: %URL%
echo The server runs in its own window "Real Simulator" with live output.
echo You can minimize that window - do not close it. Stop with: start.bat stop
if not defined SIM_NO_BROWSER start "" %URL%
exit /b 0

:do_stop
call :findpid
if not defined PID (
  echo Server is not running.
  exit /b 0
)
echo Stopping server - PID %PID% (killing process tree) ...
:stop_retry
taskkill /F /T /PID %PID% >nul 2>&1
set /a STOP_WAITS=0
:stop_wait
call :sleep2
call :findpid
if not defined PID goto :stop_done
set /a STOP_WAITS+=1
if %STOP_WAITS% lss 4 goto :stop_wait
REM Port still listening after ~8s - retry the kill once, then give up.
taskkill /F /T /PID %PID% >nul 2>&1
call :sleep2
call :findpid
if defined PID (
  echo FAILED to stop PID %PID% - close it in Task Manager manually.
  exit /b 1
)
:stop_done
echo Server stopped.
exit /b 0

:do_restart
call :do_stop
call :sleep2
call :do_start
exit /b 0

:do_status
call :status_line
echo.
call :findpid
if defined PID (
  powershell -NoProfile -Command "try { $s = Invoke-RestMethod '%URL%/api/stats'; 'Characters: ' + $s.characters + '  |  Tools: ' + $s.tools + '  |  Providers: ' + $s.providers + '  |  Scenes: ' + $s.scenes + '  |  Running now: ' + $s.running } catch { 'API not answering' }"
) else (
  echo API unreachable - server is stopped.
)
echo.
if exist "%DB%" (
  for %%F in ("%DB%") do echo Database: %DB% - %%~zF bytes
) else (
  echo Database: %DB% - not created yet, appears on first start.
)
if exist ".next\BUILD_ID" (
  for %%F in (".next\BUILD_ID") do echo Production build: %%~tF
) else (
  echo Production build: MISSING - run start.bat build
)
if exist "%LOG%" (
  for %%F in ("%LOG%") do echo Log: %LOG% - %%~zF bytes, view: start.bat log
)
exit /b 0

:do_log
if not exist "%LOG%" (
  echo Log does not exist yet: %LOG%
  exit /b 0
)
powershell -NoProfile -Command "Get-Content -Tail 60 '%LOG%'"
exit /b 0

:do_build
echo Rebuilding production bundle - 1-2 minutes...
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED - see errors above.
  exit /b 1
)
echo Build finished.
exit /b 0
