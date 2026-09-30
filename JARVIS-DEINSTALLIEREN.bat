@echo off
setlocal
title JARVIS Deinstallation
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\uninstall.ps1"
pause
