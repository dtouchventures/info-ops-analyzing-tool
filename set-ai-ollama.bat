@echo off
REM Points AIVS at the Ollama server on your network. A copy of the old settings is kept as .env.before-ollama
cd /d "%~dp0"
if not exist .env type nul > .env
copy /y .env .env.before-ollama >nul
powershell -NoProfile -Command "$k = 'AI_PROVIDER','AI_MODEL','AI_BASE_URL','AI_API_KEY','AI_TIMEOUT_MS','AI_NUM_CTX'; $lines = @(Get-Content -LiteralPath '.env' | Where-Object { $l = $_.Trim(); -not ($k | Where-Object { $l.StartsWith($_ + '=') }) }); $lines += 'AI_PROVIDER=ollama','AI_BASE_URL=http://10.104.4.151:11434','AI_MODEL=qwen3:4b-instruct','AI_TIMEOUT_MS=240000','AI_NUM_CTX=8192'; Set-Content -LiteralPath '.env' -Value $lines -Encoding ASCII"
echo.
echo  AIVS AI settings now in .env:
findstr /b "AI_PROVIDER AI_BASE_URL AI_MODEL AI_TIMEOUT_MS AI_NUM_CTX" .env
echo.
echo  The old settings are kept in .env.before-ollama
echo  Now close the black AIVS window and double-click start-windows.bat.
pause
