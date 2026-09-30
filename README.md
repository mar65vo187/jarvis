# J.A.R.V.I.S. — Claude + lokale KI

Persönlicher Assistent mit deutschem Dashboard, Werkzeugen, SQLite-Gedächtnis,
Missionen, Zeitplänen, optionaler PC-Steuerung und Telegram-Kopplung.

**Drei KI-Wege sind eingebaut:** xKiro als Multi-Modell-Gateway, Claude direkt über
die Anthropic Messages API und Ollama für vollständig lokale Inferenz. Das Dashboard
zeigt den tatsächlichen KI-Status, kann den aktuellen xKiro-Modellkatalog laden und
hat einen Cloud-Sperrschalter für reinen Offline-/Lokalbetrieb.

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
Tests simulieren Claude/Ollama und Telegram, brauchen keine Schlüssel und führen
keine echten PC-Aktionen aus. GitHub Actions prüft Linux und Windows sowie die
PowerShell-Syntax; anschließend entsteht ein Download mit dem geprüften Quellstand.

Ausführliche Einrichtung und optionale Integrationen: [ANLEITUNG.md](ANLEITUNG.md).

Offizielle Claude-Dokumentation:
[Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Werkzeuge](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
[Modelle](https://platform.claude.com/docs/en/models/overview).
