@echo off
setlocal
echo Dies deaktiviert Ollama-Cloud-Funktionen fuer dein Windows-Benutzerkonto.
echo Auch andere Programme mit Ollama koennen danach nur lokale Modelle nutzen.
choice /c JN /n /m "Einstellung setzen? [J/N]: "
if errorlevel 2 exit /b 0
setx OLLAMA_NO_CLOUD 1
if errorlevel 1 (
  echo Einstellung konnte nicht gespeichert werden. Keine erfolgreiche Aenderung bestaetigt.
  pause
  exit /b 1
)
echo Bitte Ollama in der Taskleiste beenden und danach neu starten.
echo Zum Rueckgaengigmachen die Benutzer-Umgebungsvariable OLLAMA_NO_CLOUD entfernen.
pause
