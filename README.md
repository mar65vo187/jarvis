# J.A.R.V.I.S. — Multi-Agent KI + lokale KI

Persönlicher Assistent mit deutschem Dashboard, Werkzeugen, SQLite-Gedächtnis,
Missionen, Zeitplänen, optionaler PC-Steuerung und Telegram-Kopplung.

**Drei KI-Wege sind eingebaut:** xKiro als Multi-Modell-Gateway, Claude direkt über
die Anthropic Messages API und Ollama für vollständig lokale Inferenz. Zusätzlich
besitzt Jarvis einen **Multi-Agenten-Rat**: Bei komplexen Aufgaben wählt er aus dem
Live-xKiro-Katalog mehrere unterschiedliche Spezialisten für Strategie, Recherche,
Engineering, Analyse, Kritik, Sicherheit, Kreativität und Abschlussprüfung. Diese
Agenten beraten ausschließlich; nur der Master-Jarvis erhält Werkzeuge und darf handeln.

Das Dashboard zeigt den tatsächlichen KI-Status, Agentenstatus, den aktuellen
xKiro-Modellkatalog und einen Cloud-Sperrschalter für reinen Offline-/Lokalbetrieb.

## Windows 10/11

1. **Code → Download ZIP**, ZIP vollständig entpacken.
2. `JARVIS-INSTALLIEREN.bat` starten. Beim Anbieter **C** für Claude wählen.
3. Im Jarvis-Fenster den **Anthropic-API-Schlüssel** eintragen und speichern.
4. **KI-VERBINDUNG TESTEN** klicken; danach eine Aufgabe senden.

Es wird kein API-Schlüssel mitgeliefert. Ein Claude-Chat-Abonnement stellt keinen
API-Schlüssel bereit. Claude-Nutzung wird von Anthropic separat abgerechnet;
Ollama arbeitet lokal ohne API-Gebühren. Ohne Zugang oder lokales Modell zeigt
Jarvis den fehlenden Baustein an, statt eine erfolgreiche Verbindung zu behaupten.

Updates erhalten `.env` und `data/` unter `%LOCALAPPDATA%\Jarvis`.

## Linux/macOS oder Entwicklung

Python 3.11–3.13 installieren, dann `bash start.sh`. Alternativ:

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m jarvis --show
```

Dashboard: http://127.0.0.1:8765. Keine öffentliche Netzwerkfreigabe.
Für Windows-PC-Steuerung zusätzlich `requirements-windows.txt` installieren.

## Multi-Agenten-Architektur

Bei `JARVIS_AGENT_MODE=auto` startet Jarvis den Rat nur bei Aufgaben, die von
mehreren Perspektiven profitieren. Die Modell-IDs werden **nicht hart verdrahtet**:
Jarvis liest `GET /v1/models` und berücksichtigt Anbieter, Fähigkeiten,
Zugangsstufe, Kontextgröße und Kostenpräferenz. Dadurch können neue xKiro-Modelle
automatisch Kandidaten werden, ohne den Jarvis-Code zu ändern.

Der Rat umfasst bis zu acht definierte Rollen: **Strategist, Researcher, Engineer,
Analyst, Critic, Security, Creative und Auditor**. Pro Aufgabe wird nur eine passende
Teilmenge gestartet. Der Researcher kann xKiros Live-Websuche verwenden. Ergebnisse
werden als Beratung in den Systemkontext des Masters gegeben; Seiteneffekte bleiben
zentral beim Master und seinen Freigaberegeln.

Wichtige Schalter stehen in `.env.example` und im Dashboard. Standard: maximal
5 Spezialisten, 4 parallel, kostenlose Modelle bevorzugt, Premium aus.

## Anbieter

| Einstellung | Verhalten |
|---|---|
| `JARVIS_PROVIDER=xkiro` | xKiro; Modell-ID im Format `anbieter/modell` |
| `JARVIS_PROVIDER=claude` | Claude direkt; Anthropic-API-Schlüssel erforderlich |
| `JARVIS_PROVIDER=ollama` | Lokales Ollama-Modell erforderlich |
| `JARVIS_PROVIDER=auto` | xKiro mit Schlüssel, sonst Claude, sonst Ollama |
| `JARVIS_CLOUD_ENABLED=0` | Harte Cloud-Sperre; erzwingt Ollama |

Keine automatische Wiederholung bereits ausgeführter Aufgaben mit einem anderen
Anbieter. Modell und Anbieter lassen sich im Dashboard ändern. Für xKiro wird der
Modellkatalog live über `/v1/models` geladen; API-Schlüssel werden ausschließlich
lokal in der Jarvis-`.env` gespeichert. Die standardmäßige
Claude-Kostenschätzung nutzt ein Tageslimit von 1 USD; Details in `.env.example`.
Sie ersetzt kein Abrechnungslimit beim Anbieter. Bei Modellwechsel Preise anpassen.

## Prüfen

```bash
python -m unittest discover -s tests -v
python -m jarvis --check
```

`--check` prüft Zugang und Modell ohne Textgenerierung; fehlende Verbindung gibt
Exitcode 1 zurück. Der Dashboard-Test erzeugt eine kurze echte KI-Antwort.
Tests simulieren Claude/Ollama/xKiro, Multi-Agenten, Telegram und Werkzeugaufrufe,
brauchen keine echten Schlüssel und führen keine echten PC-Aktionen aus. GitHub
Actions prüft Linux und Windows sowie einen Browser-End-to-End-Test; anschließend
entsteht ein Download mit dem geprüften Quellstand.

Ausführliche Einrichtung und optionale Integrationen: [ANLEITUNG.md](ANLEITUNG.md).

Offizielle Claude-Dokumentation:
[Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Werkzeuge](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
[Modelle](https://platform.claude.com/docs/en/models/overview).
