# J.A.R.V.I.S. — Multi-Provider + Multi-Agent + lokale KI

Persönlicher Assistent mit deutschem Dashboard, Werkzeugen, SQLite-Gedächtnis,
Missionen, Zeitplänen, PC-Steuerung, Telegram, GitHub-Remote-Kanal und einem
benchmark-gesteuerten Agent-Upgrade-System.

## Gehirne und Modellquellen

Jarvis kann vier Master-Wege nutzen:

| Einstellung | Verhalten |
|---|---|
| `JARVIS_PROVIDER=xkiro` | xKiro Multi-Modell-Gateway |
| `JARVIS_PROVIDER=huggingface` | Hugging Face Inference Providers über den OpenAI-kompatiblen Router |
| `JARVIS_PROVIDER=claude` | Claude direkt über Anthropic |
| `JARVIS_PROVIDER=ollama` | lokale Ollama-Inferenz |
| `JARVIS_PROVIDER=auto` | xKiro → Hugging Face → Claude → Ollama |
| `JARVIS_CLOUD_ENABLED=0` | harte Cloud-Sperre; nur Ollama |

Der **Agentenrat** besitzt zusätzlich einen gemeinsamen Modellpool aus xKiro,
Hugging Face und allen lokal installierten Ollama-Modellen. Er berücksichtigt
Anbieter, Fähigkeiten, Kontextgröße, Zugangsstufe, Kostenpräferenz und die von
Jarvis selbst gemessene Erfolgsquote eines Modells. Ein instabiles Modell wird
dadurch bei späteren Aufgaben automatisch schlechter gerankt.

## Multi-Agenten-Rat

Bei `JARVIS_AGENT_MODE=auto` startet der Rat nur bei komplexeren Aufgaben. Die
festen Rollen sind **Strategist, Researcher, Engineer, Analyst, Critic, Security,
Creative und Auditor**. Eine passende Teilmenge arbeitet zunächst unabhängig;
Critic/Auditor erhalten anschließend die Ergebnisse der anderen Agenten und führen
eine zweite Gegenprüfungsrunde durch.

Spezialisten sind absichtlich **advisory only**: Sie erhalten keine Datei-, PC-,
Zahlungs- oder Account-Werkzeuge. Nur der Master-Jarvis darf Side Effects
ausführen und bleibt an Freigaben/NOTAUS gebunden.

Standard: bis zu 5 Spezialisten, 4 parallel, kostenlose/lokale Modelle bevorzugt,
xKiro + Hugging Face + Ollama als Quellen, Premium bei xKiro aus.

## Agent Factory / Upgrade-System

Jarvis kann eigene **Child-Agenten** erzeugen und vermehren. Das sind versionierte
Spezialisten aus Systemprompt, Rolle und Modell-Routing — keine erfundenen neuen
Foundation-Modellgewichte.

Ein Upgrade läuft als:

`Parent → Candidate → Benchmark-Aufgaben → blinder Judge → Promote/Reject`

Der Candidate wird nur aktiviert, wenn er den Parent im Benchmark ausreichend
schlägt. Generation, Eltern-Agent, Score und Status werden in SQLite gespeichert.
Schlechtere Candidates werden verworfen; bei zu vielen Child-Agenten werden
schwächere Profile archiviert. Automatische Upgrades laufen standardmäßig einmal
pro 24 Stunden und verwenden dafür nur kostenlose/lokale Modelle, sofern verfügbar.
Über Dashboard oder Telegram `/upgrade` kann ein Lauf manuell gestartet werden.

## Windows 10/11

1. **Code → Download ZIP**, vollständig entpacken.
2. `JARVIS-INSTALLIEREN.bat` starten.
3. Anbieter wählen: **X** xKiro, **H** Hugging Face, **C** Claude oder **L** Ollama.
4. Im Jarvis-Fenster Zugang/Modell speichern und **KI-VERBINDUNG TESTEN** ausführen.

Der Installer richtet einen Benutzer-Autostart mit **Jarvis-Watchdog** ein. Der
Watchdog prüft den lokalen Health-Endpunkt und startet Jarvis nach einem Absturz
neu. Das hilft auch, den Telegram-Long-Polling-Prozess dauerhaft am Leben zu halten,
solange Windows läuft und der Benutzer angemeldet ist.

Updates behalten `.env` und `data/` unter `%LOCALAPPDATA%\Jarvis`.

## Telegram

Nach der Kopplung akzeptiert Jarvis nur die gespeicherte Telegram-ID. Neben Chat,
Missionen, Freigaben und NOTAUS gibt es:

- `/agenten` — Modellquellen, Agentenrat und aktive Child-Agenten
- `/upgrade [code|research|business|general]` — Agent Factory + Benchmark starten

Telegram ist wirklich live, solange eine Jarvis-Instanz auf deinem PC oder einem
eigenen Server läuft. GitHub Actions ist **kein** dauerhafter Telegram-Prozess.

## GitHub-Remote-Kanal

Zusätzlich enthält das Repository `.github/workflows/jarvis-remote.yml`. Sobald
die Datei auf dem Default-Branch liegt, kann der Repository-Owner in einem normalen
GitHub-Issue kommentieren:

`/jarvis Analysiere ...`

Die Action nutzt `XKIRO_API_KEY` und/oder `HF_TOKEN` aus **GitHub Actions
Secrets**, startet einen stateless Remote-Jarvis und schreibt die Antwort zurück
ins Issue. Dieser GitHub-Modus hat bewusst **keine PC-/Datei-Werkzeuge** und kann
deshalb nicht behaupten, deinen lokalen Rechner verändert zu haben.

## Hugging Face

Jarvis verwendet den OpenAI-kompatiblen Inference-Providers-Router. Im Dashboard
kann der aktuelle Modellkatalog geladen werden. `HF_POLICY=cheapest` ist der
Standard; alternativ sind `fastest` oder `preferred` vorgesehen. Für
Bildanalyse über Hugging Face muss ein geeignetes `HF_VISION_MODEL` gesetzt sein.

## Ollama lokal

Ollama bleibt der Offline-/Fallback-Weg und ist gleichzeitig eine Agentenquelle.
Alle lokal installierten Modelle aus `/api/tags` werden in den Agentenpool
aufgenommen. Lokale Modelle verursachen keine API-Kosten und werden bei
`JARVIS_AGENT_PREFER_FREE=1` bevorzugt.

## Linux/macOS oder Entwicklung

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m jarvis --show
```

Dashboard: http://127.0.0.1:8765. Der App-Server bindet absichtlich nur an
Loopback. Für Windows-PC-Steuerung zusätzlich `requirements-windows.txt`
installieren.

## Prüfen

```bash
python -m unittest discover -s tests -v
python -m jarvis --check
```

GitHub Actions testet Python 3.11/3.12 unter Ubuntu und Windows, den Windows-
Installer, Multi-Provider-Routing, Agentenrat, Upgrade-System sowie einen echten
Playwright-Browserfluss. Erst danach wird `JARVIS_READY.zip` erzeugt.

Ausführliche Einrichtung: [ANLEITUNG.md](ANLEITUNG.md).
