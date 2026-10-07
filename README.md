# J.A.R.V.I.S. — Multi-Provider + Multi-Agent + lokale KI

Persönlicher Assistent mit deutschem Dashboard, Werkzeugen, SQLite-Gedächtnis,
Missionen, Zeitplänen, PC-Steuerung, Telegram, GitHub-Remote-Kanal und einem
benchmark-gesteuerten Agent-Upgrade-System.

## Obsidian-Plug-in: Jarvis AI (lokal + Top-Cloud)

Im Ordner [`obsidian-jarvis/`](obsidian-jarvis/) liegt ein fertiges Obsidian-Plug-in,
das dieselbe Idee direkt in deinen Vault bringt:

- **Lokal** über Ollama (`qwen3.6:27b`, `gpt-oss:20b`, `qwen3:8b` …) oder **online**
  über die stärksten Modelle (Claude Opus 5.5, GPT-6 Astra, Gemini 3.8 Flash, OpenRouter)
  – umschaltbar mit einem Klick, mit automatischem Ausweichen (`⚡ Auto`).
- **Fragen an den Vault** mit Quellenangaben `[Q1]`, hybride Suche (Vektoren + BM25),
  private Notizen (`ki-privat: true`) und ausgeschlossene Ordner werden nie gelesen.
- **GitHub-Anbindung**: Der Vault wird als echte Commits gesichert und auf einem
  zweiten Rechner wiederhergestellt (nur geänderte Dateien, Vorschau vor jedem Schreiben).
- Befehle für Zusammenfassen, Aufgaben, Verbessern, Übersetzen, Plan, Gegenprüfung.
- 62 automatische Tests, alle grün – Prüfbericht und ehrliche Grenzen in
  [`obsidian-jarvis/PRUEFBERICHT.md`](obsidian-jarvis/PRUEFBERICHT.md).

**Installation:** BRAT in Obsidian installieren → „Add a beta plugin for testing" →
`mar65vo187/jarvis` → Plugin aktivieren. Alternativ die Dateien `main.js`,
`manifest.json`, `styles.css` aus dem Release in `.obsidian/plugins/jarvis-ai/` kopieren
oder den Helfer `obsidian-jarvis/install/JARVIS-INSTALLIEREN.cmd` (Windows) bzw.
`obsidian-jarvis/install/install.sh` (macOS/Linux) benutzen.

Details, Einrichtung der Modelle, Schlüssel und Fehlersuche: [`obsidian-jarvis/README.md`](obsidian-jarvis/README.md)

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
schwächere Profile archiviert. Auf dem Oracle-Server laufen automatische Upgrades
standardmäßig alle 6 Stunden. Zusätzlich bewertet Jarvis jetzt nicht nur Qualität,
sondern auch die Laufzeit: ein geringfügig besserer Candidate wird nicht aktiviert,
wenn er deutlich langsamer ist. Über Dashboard oder Telegram `/upgrade` kann ein Lauf
manuell gestartet werden.

## Adaptive Brain: mehr Denken nur wenn es sich lohnt

Jarvis klassifiziert lokale Aufgaben ohne zusätzlichen KI-Aufruf als **FAST**,
**BALANCED** oder **DEEP**. FAST nutzt ein kleines Modell ohne Denkmodus und ein
kleines Antwortbudget. DEEP nutzt das stärkere lokale Modell, aktiviert den
Denkmodus und bekommt mehr Tokens. Gemessene Latenz und Zuverlässigkeit werden nur
als aggregierte Zähler in SQLite gespeichert; Prompt-Inhalte landen nicht in den
Performance-Metriken. Das Auto-Tuning kann daraus die schnellste zuverlässige
Fast-Route und die robusteste Deep-Route auswählen.

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

## Deine eigene KI: Einbahnstraße für Daten

**Wissen darf herein – private Daten nie hinaus.** Im Code erzwungen (`jarvis/privacy.py`), mit Tests belegt
(`tests/test_privacy.py`):

| Was | Wie |
|---|---|
| Private Daten (Dateien, Mails, Bildschirm, Fotos, Kontakte, Gedächtnis, Chats) | verarbeitet **nur die lokale KI** (Ollama). Ist sie nicht bereit, bricht Jarvis ab – nichts geht an eine Cloud |
| Modus `strikt` (Standard) | **alles** läuft lokal; Cloud-KIs (xKiro/Claude) nur als **Lehrer**: einzelne allgemeine Frage, ohne Verlauf, ohne Namen/Kontaktdaten (wird geprüft) |
| Modus `smart` | Privates lokal, allgemeine Aufgaben dürfen in die Cloud (schneller/klüger), Agentenrat nur für Nicht-Privates |
| Ausgangsschleuse | in privaten Aufgaben: Suche mit persönlichen Daten blockiert; Mail/HTTP/n8n/Veröffentlichen nur nach Freigabe mit genauer Vorschau |
| Speicherung | private Nachrichten und privates Gedächtnis **verschlüsselt** (Schlüssel getrennt in `data/jarvis.key`) |
| Bilder | nur lokales Seh-Modell (`JARVIS_VISION_MODEL`), nie Cloud |

**Selbstverbesserung – Jarvis wird stärker:**
1. **Eigenes Wissen** (`jarvis/knowledge.py`): Jede Lehrer-Antwort und jede gute Cloud-Antwort auf eine
   allgemeine Frage wird dauerhaft gespeichert und bei passenden Aufgaben mitgegeben – auch der lokalen KI.
   So lernt **deine** KI von den großen Modellen, ohne dass Privates hinausgeht. Telegram: `/wissen`.
2. **Eigene Skills**: Jarvis baut sich neue Werkzeuge (nach deiner Freigabe, versioniert, zurücksetzbar).
3. **Besseres lokales Modell**: neue Modelle direkt von Hugging Face (`ollama pull hf.co/<name>/<modell>:Q4_K_M`).
4. **Code**: Weiterentwicklung über GitHub (Tests + automatisches Aufspielen, Rückfall bei Fehlstart).

Hinweis: Telegram kann Bot-Chats lesen. Sehr Privates im Jarvis-Fenster (über Tailscale) schreiben
oder mit `/privat …` beginnen – dann bleibt die Verarbeitung lokal, Telegram transportiert aber den Text.

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
5 Spezialisten, 4 parallel, kostenlose Modelle bevorzugt, Premium aus. Autonome
Missionen holen den Rat im ersten Zyklus und anschließend standardmäßig alle vier
Zyklen erneut hinzu, damit Daueraufgaben nicht bei jedem Lauf unnötig viele Modelle
aufrufen.

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

GitHub Actions testet Python 3.11/3.12 unter Ubuntu und Windows, den Windows-
Installer, Multi-Provider-Routing, Agentenrat, Upgrade-System sowie einen echten
Playwright-Browserfluss. Erst danach wird `JARVIS_READY.zip` erzeugt.

Ausführliche Einrichtung: [ANLEITUNG.md](ANLEITUNG.md).

## Online rund um die Uhr (Oracle Cloud, Always Free) – nur für dich erreichbar

Oracle stellt dauerhaft kostenlos einen ARM-Server bereit (laut Oracle-Doku 2026: 2 OCPU + 12 GB RAM).
Darauf laufen Jarvis, die lokale KI (Ollama) und tägliche verschlüsselte Backups.
Bei genügend RAM/CPU hält der Installer zwei lokale Modelle gleichzeitig warm:
ein kleines Fast-Modell für Routine und ein stärkeres Deep-Modell für komplexe
Aufgaben. Ollama darf dann zwei Anfragen parallel verarbeiten.

1. **Tailscale** (kostenlos): Konto anlegen, App auf Handy und PC installieren,
   Admin → *Settings → Keys* → **Auth key** erzeugen, Admin → *DNS* → **HTTPS Certificates** einschalten.
2. **Eigenen Telegram-Bot** für die Online-Version anlegen (nicht denselben wie am PC).
3. Inhalt von [`deploy/oracle/cloud-init.yaml`](deploy/oracle/cloud-init.yaml) kopieren und ausfüllen:
   Bot-Token, Passwort, `TS_AUTHKEY`, optional `XKIRO_API_KEY` (Lehrer). **Ausgefüllt nie ins Repo.**
4. Oracle → Compute → Instanz erstellen: Ubuntu 24.04, Shape `VM.Standard.A1.Flex` (2 OCPU, 12 GB),
   SSH-Schlüssel speichern, *Erweiterte Optionen → Management → cloud-init* einfügen.
5. Nach 15–25 Min. auf dem Handy (Tailscale an): `https://jarvis.<dein-tailnet>.ts.net` öffnen,
   mit Passwort anmelden, angezeigten Code als `/koppeln 123456` an den Online-Bot schicken.

Mit Tailscale ist **kein Port** im Internet offen (keine Oracle-Firewall-Regeln nötig). Ohne `TS_AUTHKEY`
richtet das Skript stattdessen öffentliches HTTPS mit Login-Sperre ein (dann TCP 80/443 in der Oracle
Security List freigeben).

Wartung per SSH: `sudo cat /root/jarvis-zugang.txt` (Adresse, Passwort, **Schlüssel sichern!**),
`sudo journalctl -u jarvis -f`, Update `sudo /opt/jarvis/deploy/oracle/update.sh` (Rückfall bei Fehlstart),
Backup `sudo /opt/jarvis/deploy/oracle/backup.sh` (läuft täglich automatisch, Schlüssel nicht im Backup).

**Automatisch deployen:** Repo → Settings → Secrets → Actions: `ORACLE_HOST`, `ORACLE_SSH_KEY`
(bei Tailscale: Tailscale-IP und einen GitHub-Runner im Tailnet, oder Update von Hand).
