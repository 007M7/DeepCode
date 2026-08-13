@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deepcode.ps1" %*
exit /b %errorlevel%
