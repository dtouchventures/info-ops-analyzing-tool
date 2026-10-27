@echo off
rem Connect AIVS to the transcription service on the Ubuntu server. Reads the token over SSH (nothing to paste),
rem then writes TRANSCRIBE_URL and TRANSCRIBE_TOKEN into .env. A copy of the old .env is kept as .env.before-transcribe.
rem Usage: set-transcribe.bat [server address] [path to SSH key]
setlocal
cd /d "%~dp0"
set "SERVER=%~1"
if "%SERVER%"=="" set "SERVER=10.104.4.151"
set "KEY=%~2"
if "%KEY%"=="" set "KEY=%USERPROFILE%\Downloads\Lab1.pem"
if not exist ".env" ( echo .env not found in %CD%. Run start-windows.bat once first. & pause & exit /b 1 )
if not exist "%KEY%" ( echo SSH key not found: %KEY% & pause & exit /b 1 )
echo Reading the transcription token from ubuntu@%SERVER% ...
ssh -i "%KEY%" -o ConnectTimeout=15 ubuntu@%SERVER% "cat ~/aivs-transcribe-token.txt" > "%TEMP%\aivs-tt.txt"
if errorlevel 1 ( echo Could not read the token. Check that install.sh finished on the server. & del "%TEMP%\aivs-tt.txt" 2>nul & pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = (Get-Content -Raw $env:TEMP\aivs-tt.txt).Trim(); if ($t.Length -lt 20) { Write-Host 'The token looks wrong.'; exit 1 };" ^
  "Copy-Item .env .env.before-transcribe -Force;" ^
  "$l = Get-Content .env | Where-Object { $_ -notmatch '^\s*TRANSCRIBE_(URL|TOKEN)\s*=' };" ^
  "$l += 'TRANSCRIBE_URL=http://%SERVER%:9000'; $l += ('TRANSCRIBE_TOKEN=' + $t);" ^
  "[IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), [string[]]$l); Write-Host 'Done: .env now points to http://%SERVER%:9000 (token saved, not shown).'"
set "RC=%ERRORLEVEL%"
del "%TEMP%\aivs-tt.txt" 2>nul
if not "%RC%"=="0" ( pause & exit /b 1 )
echo Close the AIVS window if it is open, then run start-windows.bat again.
pause
