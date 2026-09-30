@echo off
setlocal
title JARVIS Installation
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1"
if errorlevel 1 (
  echo.
  echo Installation fehlgeschlagen. Siehe Meldung oben.
  pause
  exit /b 1
)
pause
