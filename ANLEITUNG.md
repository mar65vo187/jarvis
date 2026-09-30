# Jarvis einrichten und verwenden

## 1. Windows installieren

1. Im GitHub-Repository **Code → Download ZIP** wählen.
2. ZIP mit **Alle extrahieren** vollständig entpacken; Installer nicht direkt im ZIP starten.
3. `JARVIS-INSTALLIEREN.bat` doppelklicken.
4. Der Installer installiert Python im Benutzerkonto, richtet die Python-Umgebung
   ein und kopiert Jarvis nach `%LOCALAPPDATA%\Jarvis`.
5. Zusatzpakete sind optional. Für reine Textaufgaben **N** wählen.
6. Bei der KI-Auswahl **C** für Claude oder **L** für Ollama wählen.
7. Im geöffneten Fenster Einrichtung speichern, dann **KI-VERBINDUNG TESTEN**.

Autostart und Desktop-Verknüpfung werden eingerichtet. Jarvis läuft mit deinen
normalen Benutzerrechten. Updates behalten Einstellungen, Chats, Gedächtnis,
Missionen, Sicherungen und eigene Skills. Keine Datenbank wird zurückgesetzt.

## 2. Claude verbinden

1. In der [Claude Console](https://platform.claude.com/) einen eigenen
   Anthropic-API-Schlüssel erzeugen und API-Abrechnung einrichten.
2. Im Jarvis-Fenster **EINSTELLUNGEN** öffnen.
3. Anbieter **Claude** wählen, API-Schlüssel eintragen.
4. Modell voreingestellt: `claude-sonnet-5-5`; ein anderes für deinen Zugang
   verfügbares Modell kannst du ebenfalls eintragen.
5. Tagesbudget einstellen; Standard **1 USD** nach Kostenschätzung.
6. **SPEICHERN & STARTEN**. Jarvis prüft den Zugang und das Modell.
7. **KI-VERBINDUNG TESTEN** erzeugt eine echte kurze Antwort.
8. Schreibe beispielsweise: „Erstelle im Arbeitsordner eine Datei test.txt mit dem Text Hallo Marvin und prüfe sie.“

Ein Claude-Chat-Abonnement allein ersetzt den API-Zugang nicht. Claude-Anfragen
und Bildanalysen gehen an Anthropic. Der Schlüssel liegt in der lokalen `.env`,
wird nicht im Dashboard zurückgegeben und gehört niemals in GitHub.

Das Budget nutzt konfigurierbare Preise und eine vorsichtige Schätzung vor jeder
Anfrage; nach der Antwort werden Tokens protokolliert. Dies ist kein garantiertes
Abrechnungslimit. Bei Modellwechsel `CLAUDE_PRICE_IN` und `CLAUDE_PRICE_OUT`
(USD je Million Tokens) nach aktueller Preisliste ändern. `0` deaktiviert das
Jarvis-Tageslimit. Ollama benötigt kein API-Budget.

## 3. Ollama lokal

Bei Installation **L** wählen. Der Installer installiert Ollama, startet dessen
lokalen Dienst und lädt ein Modell passend zum Arbeitsspeicher. Dieser erste
Download umfasst mehrere GB. Ein Seh-Modell ist optional.

| RAM | Voreinstellung |
|---|---|
| 16 GB oder mehr | `qwen3:8b` |
| 5–15 GB | `qwen3:4b-instruct-2507-q4_K_M` |
| unter 5 GB | `qwen3:1.7b` |

Kleine Modelle sind bei komplexen Aufgaben deutlich schwächer als Cloudmodelle.
Mit 6 GB RAM wird es knapp; große andere Programme schließen. Für Textaufgaben
ist kein Seh-Modell erforderlich. Für Screenshots benötigt Ollama ein Seh-Modell;
Claude kann Bilder ohne zusätzliches lokales Modell analysieren.

## 4. Telegram optional verbinden

1. In Telegram **@BotFather → /newbot** und eigenen Bot erstellen.
2. Bot-Token in Jarvis **EINSTELLUNGEN** eintragen, speichern.
3. Dashboard zeigt `/koppeln 123456` mit deinem aktuellen Code.
4. Diesen Befehl deinem Bot im privaten Chat senden.

Nach Kopplung reagiert er nur auf freigegebene Telegram-IDs.

| Befehl | Wirkung |
|---|---|
| Nachricht / Foto / Dokument | Aufgabe an Jarvis |
| `/status` | Anbieter, Missionen und Freigaben |
| `/missionen`, `/log 3` | Missionen anzeigen |
| `/pause 3`, `/weiter 3`, `/stopp 3` | Mission steuern |
| `/ja 12`, `/nein 12` | Freigabe beantworten |
| `/screenshot` | PC-Bildschirm, falls verfügbar |
| `/notaus` | Neue Aktionen blockieren, Missionen pausieren |
| `/weiter` | NOTAUS aufheben; Missionen separat weiterführen |
| `/neu` | Gespräch leeren; Gedächtnis behalten |

Spracheingabe in Telegram braucht das optionale `faster-whisper`-Paket.
Windows/Browser können je nach Installation für das Dashboard auch eigene
Spracherkennung und Sprachausgabe bereitstellen. Browser-Sprachdienste können
Cloud-Dienste nutzen. Telegram-Sprachausgabe ist derzeit nicht implementiert;
Telegram-Antworten kommen als Text.

## 5. Funktionen und Voraussetzungen

Chats, Gedächtnis, Missionen, Zeitpläne, Dateiwerkzeuge und eigene Skills nutzen
SQLite und den lokalen Arbeitsordner. Die ausgewählte KI muss erreichbar sein.
„Lernen“ bedeutet gespeichertes Wissen und zusätzliche Werkzeuge; es trainiert
keine neuen Modellgewichte und garantiert keine höhere Leistung als Claude/GPT.

PC-Steuerung braucht einen laufenden Windows-PC mit Bildschirm und die
Windows-Pakete. Notaus und Freigaben schützen bestimmte Aktionen; Shellbefehle
und freigegebene Skills sind kein isolierter Sandkasten.

Externe Funktionen benötigen jeweils deinen eigenen Zugang:

| Funktion | Einrichten |
|---|---|
| SMTP / IMAP | Mailserver, Benutzername, Passwort |
| Stripe | Eigener Stripe-Schlüssel |
| n8n | Bestehender n8n-Server, Webhook und Geheimwort |
| Web-Recherche | Internetzugang; Suchanbieter muss erreichbar sein |

`online/` enthält optional ein separates n8n-/Caddy-Setup für deinen eigenen
Linux-Server und eine Domain. Es wurde hier kein Server gebucht oder bereitgestellt.
Wenn der PC ausgeschaltet ist, führt der lokale Jarvis keine Missionen aus.
Nur separat eingerichtete n8n-Workflows laufen auf einem Server weiter.

## 6. Diagnose

| Problem | Lösung |
|---|---|
| Claude-Schlüssel fehlt | EINSTELLUNGEN → Anthropic-API-Schlüssel speichern |
| Claude 401 | Schlüssel in der Console prüfen/erneuern |
| Claude-Modell fehlt | Für deinen Zugang verfügbares Modell einstellen |
| Claude-Guthaben/Limit | API-Abrechnung prüfen oder auf Ollama wechseln |
| Ollama offline | Ollama starten; im Terminal `ollama serve` |
| Lokales Modell fehlt | `ollama pull MODELLNAME` |
| Windows-Fenster startet nicht | `%LOCALAPPDATA%\Jarvis\data\jarvis.log` prüfen |
| Port 8765 belegt | Andere Jarvis-Instanz schließen oder `PORT` in `.env` ändern |

`python -m jarvis --check` liefert eine maschinenlesbare Diagnose.
`/health` prüft den App-Server; `ai_ready` zeigt getrennt den KI-Status.

## 7. Daten und Deinstallation

Windows: `%LOCALAPPDATA%\Jarvis\.env` und `data\`.
Direkter Start aus dem Repository: `.env` und `data/` dort; über `DATA_DIR`
und `JARVIS_ENV_FILE` anpassbar. Sicherungen liegen unter `data/backups`.

`JARVIS-DEINSTALLIEREN.bat` entfernt Jarvis-Autostart und Verknüpfungen und
beendet die App. Deine Daten bleiben erhalten. Ollama bleibt separat installiert.
