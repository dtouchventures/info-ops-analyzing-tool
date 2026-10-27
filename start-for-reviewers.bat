@echo off
REM Start AIVS so that reviewers on the SAME trusted Wi-Fi or office network can open it from their own computers.
REM The addresses to give them are shown in the AIVS window and saved in network-address.txt in this folder.
REM For use on this computer only, use start-windows.bat instead.
set HOST=0.0.0.0
call "%~dp0start-windows.bat"
