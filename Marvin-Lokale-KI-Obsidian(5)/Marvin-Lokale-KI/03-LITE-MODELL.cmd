@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0tools\Setup.ps1" -Mode Lite
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Vorgang nicht vollstaendig erfolgreich. Fehlertext oben beachten.
pause
exit /b %RESULT%
