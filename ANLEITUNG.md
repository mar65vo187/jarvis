# Jarvis einrichten und verwenden

## 1. Windows installieren

1. Im GitHub-Repository **Code → Download ZIP** wählen.
2. ZIP vollständig mit **Alle extrahieren** entpacken.
3. `JARVIS-INSTALLIEREN.bat` doppelklicken.
4. Zusatzpakete für Sprache/Office sind optional.
5. KI wählen: **X** xKiro, **H** Hugging Face, **C** Claude oder **L** Ollama.
6. Im geöffneten Jarvis-Fenster Zugang und Modell speichern.
7. **KI-VERBINDUNG TESTEN** ausführen.

Der Installer kopiert Jarvis nach `%LOCALAPPDATA%\Jarvis`, behält vorhandene
`.env`-/SQLite-Daten bei und richtet Desktop-/Startmenü-Links ein.

Zusätzlich wird **Jarvis-Watchdog** eingerichtet. Er läuft im Benutzer-Autostart,
prüft den lokalen `/health`-Endpunkt und startet Jarvis nach einem Absturz neu.
Das funktioniert, solange der Windows-PC eingeschaltet und der Benutzer angemeldet
ist.

## 2. xKiro verbinden

1. xKiro-API-Schlüssel erzeugen.
2. **EINSTELLUNGEN → xKiro** wählen.
3. Schlüssel eintragen.
4. Mit **XKIRO-MODELLE LADEN** den aktuellen Katalog laden.
5. Modell und optional Reasoning-Stufe wählen.
6. Speichern und Verbindung testen.

xKiro ist die breiteste Cloud-Quelle im Agentenrat und unterstützt in Jarvis auch
die Websuche des Researcher-Agenten.

## 3. Hugging Face Inference Providers

1. In Hugging Face einen User Access Token mit Berechtigung für Inference Providers
   erstellen.
2. In Jarvis **Hugging Face** als Master-Anbieter wählen oder nur als
   **Agentenquelle Hugging Face** aktivieren.
3. `HF_TOKEN` speichern.
4. **HF-MODELLE LADEN** klicken und ein kompatibles Chat-Modell wählen.
5. Routing-Policy auswählen; Standard ist `cheapest`.
6. Für Bildanalyse optional ein geeignetes `HF_VISION_MODEL` eintragen.

Jarvis spricht den OpenAI-kompatiblen Hugging-Face-Router direkt per HTTP an.
Deshalb muss lokal kein großes Python-Transformers-Paket installiert werden, wenn
du nur Inference Providers benutzt.

## 4. Claude direkt

1. In der Anthropic Console einen API-Schlüssel und API-Abrechnung einrichten.
2. **Claude** als Anbieter wählen.
3. Schlüssel und ein für deinen Zugang verfügbares Modell speichern.
4. Tagesbudget/Kostenschätzung prüfen.
5. Verbindung testen.

Ein Claude-Chat-Abo ersetzt keinen API-Schlüssel.

## 5. Ollama lokal

Bei Installation **L** wählen, wenn der Master vollständig lokal laufen soll.
Ollama bleibt außerdem unabhängig vom Master-Anbieter eine mögliche Quelle für
den Agentenrat.

| RAM | Installer-Voreinstellung |
|---|---|
| 16 GB oder mehr | `qwen3:8b` |
| 5–15 GB | `qwen3:4b-instruct-2507-q4_K_M` |
| unter 5 GB | `qwen3:1.7b` |

Jarvis liest alle lokal installierten Ollama-Modelle über `/api/tags` ein.
Damit können zusätzliche lokale Modelle ohne Jarvis-Codeänderung Agentenkandidaten
werden. Große Modelle brauchen entsprechend RAM/VRAM und Plattenplatz.

Mit **Cloud-KI = AUS** werden xKiro, Hugging Face und Claude für den Master
gesperrt; der Master fällt auf Ollama zurück.

## 6. Multi-Agenten-Rat

Unter **EINSTELLUNGEN → Multi-Agenten-Rat** stehen drei Modellquellen:

- xKiro
- Hugging Face
- lokales Ollama

Jarvis vereinigt deren Kataloge in einem Modellpool. Auswahlkriterien sind
Spezialistenrolle, Anbieter, Reasoning-/Tool-/Vision-Fähigkeit, Kontextgröße,
Kostenpräferenz sowie eine lokal gemessene Erfolgsquote des Modells.

Feste Rollen: Strategist, Researcher, Engineer, Analyst, Critic, Security,
Creative und Auditor. Bei komplexen Aufgaben laufen zuerst unabhängige
Spezialisten. Danach bekommen Critic/Auditor die anderen Antworten und prüfen
Widersprüche und unbelegte Aussagen.

**Wichtig:** Spezialisten bekommen keine Werkzeuge, die Dateien, PC, Zahlungen oder
Konten verändern. Side Effects bleiben beim Master-Jarvis und seinen Freigaben.

## 7. Agent Factory / Upgrade-System

Das Upgrade-System baut neue **Child-Agenten**. Ein Child-Agent ist eine neue,
versionierte Kombination aus Rolle/Systemprompt und Modellpräferenzen. Das ist
echte Agenten-Evolution, aber **kein Training neuer Foundation-Modellgewichte**.

Ablauf:

1. Parent-Agent auswählen.
2. Factory-Modell erzeugt einen Candidate.
3. Parent und Candidate bearbeiten identische Benchmark-Aufgaben.
4. Ein separater Judge bewertet die Antworten blind als A/B.
5. Die Seiten werden zwischen Benchmarks getauscht, um Positionsbias zu reduzieren.
6. Nur ein Candidate mit ausreichendem Score wird aktiviert.
7. Generation, Parent, Score und Status landen in SQLite.
8. Schlechtere Candidates werden verworfen; alte schwächere Children können
   archiviert werden.

Standardmäßig läuft ein Auto-Upgrade höchstens alle 24 Stunden und verwendet nur
kostenlose/lokale Modelle, sofern verfügbar. Manuell geht es über den Dashboard-
Button **AGENT-UPGRADE STARTEN** oder Telegram:

`/upgrade`

Optional:

`/upgrade code`
`/upgrade research`
`/upgrade business`
`/upgrade general`

## 8. Telegram

1. Bei **@BotFather → /newbot** einen eigenen Bot erstellen.
2. Token in Jarvis speichern.
3. Den im Dashboard angezeigten `/koppeln 123456`-Befehl an den Bot senden.
4. Danach akzeptiert Jarvis nur gespeicherte Telegram-IDs.

Wichtige Befehle:

| Befehl | Wirkung |
|---|---|
| normale Nachricht | Aufgabe an Master-Jarvis |
| `/status` | Anbieter, Missionen, Agentenstatus |
| `/agenten` | Modellquellen und Child-Agenten |
| `/upgrade [typ]` | Agent Factory starten |
| `/missionen`, `/log <id>` | Missionen |
| `/ja <id>`, `/nein <id>` | Freigaben |
| `/screenshot` | PC-Bildschirm, falls verfügbar |
| `/notaus` | Aktionen blockieren und Missionen pausieren |
| `/weiter` | NOTAUS aufheben |
| `/neu` | Chatverlauf leeren |

Telegram verwendet Long Polling und verbindet sich bei Netzwerkfehlern selbst neu.
Der Windows-Watchdog startet den Jarvis-Prozess nach einem Absturz neu.

**Grenze:** Ist dein PC aus oder Windows nicht angemeldet, kann die lokale Instanz
nicht auf Telegram antworten. Für echte 24/7-Telegram-Erreichbarkeit brauchst du
einen dauerhaft laufenden Rechner/VPS, auf dem Jarvis oder ein dafür vorgesehener
Remote-Dienst läuft.

## 9. GitHub-Remote-Jarvis

Das Repository enthält `.github/workflows/jarvis-remote.yml`. Dieser Kanal ist
bewusst stateless und advisory-only.

Einrichtung:

1. Repository **Settings → Secrets and variables → Actions** öffnen.
2. Mindestens eines der Secrets anlegen:
   - `XKIRO_API_KEY`
   - `HF_TOKEN`
3. Ein normales GitHub-Issue im Repository öffnen.
4. Als Repository-Owner kommentieren:

`/jarvis Vergleiche ...`

GitHub Actions startet dann den Remote-Jarvis und schreibt die Antwort in das
Issue zurück. Andere GitHub-Nutzer können den Job nicht mit `/jarvis` auslösen,
weil der Workflow den Actor gegen den Repository-Owner prüft.

Der GitHub-Remote-Modus hat **keine lokalen PC-/Datei-Werkzeuge**. Er ist ein
zusätzlicher KI-Zugang und kein Ersatz für den lokalen Executor.

GitHub Actions selbst ist kein geeigneter 24/7-Telegram-Daemon: gehostete Jobs
haben Laufzeitgrenzen und geplante Workflows sind periodisch, nicht dauerhaft.
Der GitHub-Kanal funktioniert deshalb ereignisbasiert.

## 10. Sicherheit und Kosten

- API-Schlüssel gehören in lokale `.env` oder GitHub Actions Secrets, nie in Git.
- **Cloud-KI = AUS** erzwingt für den Master Ollama.
- Agentenquellen lassen sich einzeln deaktivieren.
- `kostenlose Modelle bevorzugen` priorisiert xKiro-free/Ollama-local.
- Hugging-Face-Inference-Provider sind als `metered` behandelt; Auto-Upgrades
  mit **nur kostenlos/lokal** nutzen sie deshalb nicht.
- Premium-xKiro-Modelle sind im Agentenrat standardmäßig deaktiviert.
- NOTAUS und bestehende Freigaberegeln bleiben für Side Effects erhalten.

## 11. Diagnose

| Problem | Lösung |
|---|---|
| xKiro fehlt | xKiro-Key speichern, Katalog laden |
| Hugging Face fehlt | HF-Token mit Inference-Berechtigung speichern |
| HF-Modell fehlt | **HF-MODELLE LADEN** und Modell wählen |
| Agentenrat leer | mindestens xKiro, HF oder Ollama als Agentenquelle verfügbar machen |
| Auto-Upgrade überspringt | kein kostenloses/lokales geeignetes Modell verfügbar oder Intervall noch nicht fällig |
| Telegram antwortet nach Absturz nicht | `data\watchdog.log` und `data\jarvis.log` prüfen |
| Telegram antwortet bei ausgeschaltetem PC nicht | dauerhaft laufenden Host/VPS verwenden |
| GitHub `/jarvis` antwortet nicht | Actions aktiviert? Secret vorhanden? Kommentar vom Repo-Owner? |
| Ollama offline | Ollama starten; ggf. `ollama serve` |
| lokales Modell fehlt | `ollama pull MODELLNAME` |
| Port 8765 belegt | andere Instanz schließen oder `PORT` ändern |

`python -m jarvis --check` prüft den aktiven Master-Anbieter. `/health` prüft
den lokalen Jarvis-Prozess.

## 12. Daten

Windows: `%LOCALAPPDATA%\Jarvis\.env` und `data\`.

SQLite enthält Chats, Gedächtnis, Missionen, Agentenprofile, Upgrade-Historie und
Modell-Zuverlässigkeitsmetriken. Updates sollen diese Daten nicht zurücksetzen.
