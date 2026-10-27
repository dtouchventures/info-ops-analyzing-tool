@echo off
rem Test AIVS speech-to-text end to end with the real transcription service set in .env.
rem It uses a temporary, separate copy of AIVS (your cases are not touched) and synthetic recordings.
rem The token is never shown. Results are also saved in data\transcribe-check.txt.
setlocal
cd /d "%~dp0"
echo Testing speech-to-text (this can take a few minutes on a CPU server) ...
node scripts\check-transcribe.js
echo.
pause
