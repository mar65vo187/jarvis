@echo off
chcp 65001 >nul
title Jarvis AI - entfernen
set /p VAULT="Pfad zu deinem Vault (Ordner mit .obsidian): "
set ZIEL=%VAULT%\.obsidian\plugins\jarvis-ai
if not exist "%ZIEL%" (
  echo Plugin-Ordner nicht gefunden: %ZIEL%
  pause
  exit /b 1
)
echo.
echo Entfernt werden die Plugin-Dateien (main.js, manifest.json, styles.css).
echo Deine Notizen und Einstellungen bleiben erhalten.
set /p SICHER="Wirklich entfernen? (j/n): "
if /i not "%SICHER%"=="j" exit /b 0
del /q "%ZIEL%\main.js" 2>nul
del /q "%ZIEL%\manifest.json" 2>nul
del /q "%ZIEL%\styles.css" 2>nul
echo Entfernt. In Obsidian das Plugin noch deaktivieren.
pause
