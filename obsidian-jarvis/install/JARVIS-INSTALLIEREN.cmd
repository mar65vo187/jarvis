@echo off
chcp 65001 >nul
title Jarvis AI fuer Obsidian - Einrichtung
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Windows.ps1"
if errorlevel 1 (
  echo.
  echo Es ist ein Fehler aufgetreten. Bitte die Meldung oben lesen.
  pause
)
