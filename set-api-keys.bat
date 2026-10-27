@echo off
rem Connect AIVS to platform APIs (YouTube, X, Facebook, Instagram, Telegram, Reddit, Bluesky, Mastodon, news feeds,
rem TikTok research, Google Fact Check, Brave). Asks for each key with hidden typing and saves them in .env.
rem Keys are never shown or sent anywhere. The old .env is kept as .env.before-keys.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-api-keys.ps1"
pause
