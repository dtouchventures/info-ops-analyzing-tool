@echo off
REM Start AIVS on Windows. Requires Node.js 22 or later (https://nodejs.org, choose "LTS").
REM Re-open in a window that never closes on its own, so every message stays readable.
if not "%AIVS_KEEP%"=="1" (
  set AIVS_KEEP=1
  start "AIVS server - keep this window open" cmd /k "%~f0"
  exit /b
)
cd /d "%~dp0"
set LOG=%~dp0start-log.txt
echo ==== AIVS start %date% %time% ==== > "%LOG%"
echo Folder: %~dp0>> "%LOG%"
echo.
echo  AIVS - starting. A log is written to start-log.txt in this folder.
echo.

where node >> "%LOG%" 2>&1
if errorlevel 1 (
  echo RESULT: Node.js not found>> "%LOG%"
  echo  Node.js is not installed on this computer, or Windows cannot find it yet.
  echo  1. Open https://nodejs.org and install the LTS version ^(accept the defaults^).
  echo  2. Restart the computer ^(or sign out and in^), then double-click start-windows.bat again.
  echo.
  start "" https://nodejs.org/en/download
  goto :end
)
set NODEMAJOR=
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node" 2^>nul') do set NODEMAJOR=%%v
echo Node major version: %NODEMAJOR%>> "%LOG%"
if "%NODEMAJOR%"=="" (
  echo RESULT: node did not report a version>> "%LOG%"
  echo  Node.js was found but did not start correctly. Reinstall the LTS version from https://nodejs.org.
  goto :end
)
if %NODEMAJOR% LSS 22 (
  echo RESULT: Node.js too old>> "%LOG%"
  echo  Node.js %NODEMAJOR% is too old. Install the LTS version from https://nodejs.org, then run this again.
  goto :end
)
echo  Node.js %NODEMAJOR% found.

if not exist node_modules\pdfkit (
  echo  Installing AIVS components. The first time takes one to three minutes and needs internet...
  echo Installing components>> "%LOG%"
  call npm install --omit=dev --no-audit --no-fund >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo RESULT: npm install failed>> "%LOG%"
    echo.
    echo  Installation failed. The last lines of start-log.txt:
    powershell -NoProfile -Command "Get-Content -Tail 15 '%LOG%'"
    echo.
    echo  Check the internet connection and run this file again.
    goto :end
  )
  echo Components installed>> "%LOG%"
  echo  Components installed.
)

REM if an older copy of AIVS is still running (for example in a minimised window), stop it so the update takes effect
set AIVSPORT=8080
if defined PORT set AIVSPORT=%PORT%
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%AIVSPORT% .*LISTENING"') do (
  tasklist /fi "PID eq %%p" /fo csv /nh | findstr /i "node.exe" >nul && (
    echo  An older copy of AIVS was still running. Stopping it so the new version starts...
    echo Stopped older AIVS process %%p>> "%LOG%"
    taskkill /pid %%p /f >nul 2>&1
    timeout /t 2 /nobreak >nul
  )
)
set AIVS_OPEN_BROWSER=1
echo Starting server>> "%LOG%"
echo  Starting AIVS. Your browser will open at http://localhost:8080 when it is ready.
echo  Keep this window open while you use AIVS. Close it to stop AIVS.
echo.
node server/index.js
echo RESULT: server stopped, exit code %errorlevel%>> "%LOG%"
echo.
echo  AIVS has stopped. If this was unexpected, the reason is shown above.

:end
echo.
echo  You can close this window.
