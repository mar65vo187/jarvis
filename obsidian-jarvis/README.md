# Jarvis AI für Obsidian — lokal **und** online

Ein KI-Assistent, der direkt in Obsidian lebt: Er kennt deine Notizen, antwortet
mit Quellenangaben, kann komplett auf deinem Rechner laufen (Ollama) — und wenn du
mehr Qualität brauchst, mit einem Klick die stärksten Cloud-Modelle benutzen.
Dazu eine echte GitHub-Anbindung: dein Vault wird als Commits gesichert und kann
auf einem zweiten Rechner wiederhergestellt werden.

| | |
|---|---|
| **Plugin-Name** | Jarvis AI (lokal + Top-Cloud) |
| **Plugin-Kennung** | `jarvis-ai` |
| **Version** | 1.0.1 |
| **Voraussetzung** | Obsidian ab 1.5 (Desktop und Mobil) |
| **Automatische Tests** | 63 Tests, alle grün (siehe [PRUEFBERICHT.md](PRUEFBERICHT.md)) |

---

## 1. Was das Plugin kann

- **Drei Betriebsarten**: `🏠 Lokal` (nur dein Rechner), `⚡ Auto` (lokal, weicht bei
  Bedarf automatisch auf ein Top-Modell aus), `☁️ Cloud` (immer bestes Modell).
- **Fragen an deinen Vault** mit Quellenangaben. Die benutzten Notizen erscheinen
  als anklickbare Verweise unter der Antwort — du kannst jede Aussage am Original prüfen.
- **Aufgaben direkt aus Obsidian**: zusammenfassen, Aufgaben herausarbeiten, Text
  verbessern, übersetzen, Plan erstellen, gegenprüfen, Arbeitsbereich „gründlich".
- **Auswahl im Editor** erklären bzw. per Cloud-Modell überarbeiten und ersetzen.
- **Hybride Wissenssuche**: Bedeutungssuche über ein lokales Embedding-Modell **plus**
  Stichwortsuche (BM25). Ohne Embedding-Modell funktioniert es weiterhin per Stichwortsuche.
- **Lokale Modelle** werden automatisch erkannt; Jarvis wählt selbst das stärkste installierte.
- **Cloud-Modelle** über einen Schlüssel: Claude, GPT, Gemini, OpenRouter (oder jeder
  OpenAI-kompatible Dienst wie Groq, DeepSeek, LM Studio, vLLM).
- **GitHub-Sicherung**: ein Commit für den ganzen Vault, nur geänderte Dateien werden
  übertragen; Wiederherstellung mit Vorschau-Dialog vor dem Schreiben.
- **Kostenschätzung** pro Cloud-Antwort (grob, ohne Gewähr) und Tokenzahlen.
- **Private Notizen** (`ki-privat: true`) und ausgeschlossene Ordner werden nie gelesen.

---

## 2. Wie es arbeitet

```
Deine Frage
   │
   ├─ Wissenssuche im Vault   →  passende Notiz-Abschnitte  (+ aktuell geöffnete Notiz)
   │                                │
   │                                └─ Vektoren (lokal)  +  Stichworte (BM25)
   │
   ├─ Prompt-Bau (deutsch, mit Quellen [Q1], [Q2] … und Regeln gegen Erfindungen)
   │
   └─ Modellwahl
        🏠 Lokal  → Ollama auf deinem PC
        ⚡ Auto   → erst lokal; wenn lokal fehlt/scheitert/unbrauchbar → Cloud
        ☁️ Cloud  → Claude / GPT / Gemini / OpenRouter
   │
Streaming-Antwort mit Quellenangaben, Verlauf und Bedienknöpfen
```

**Ausweichen im Auto-Modus** passiert, wenn: lokal kein Modell läuft, Ollama nicht
erreichbar ist, die lokale Antwort leer/unbrauchbar ist, oder die Aufgabe als groß
erkannt wird (sehr lange Frage, sehr viel Kontext, typische Analyseaufträge).
Im Protokoll unter der Antwort steht immer, welches Modell geantwortet hat.

---

## 3. Installation

### Weg A — über GitHub (empfohlen, mit automatischen Updates)

1. In Obsidian das Community-Plugin **BRAT** installieren und aktivieren
   (Einstellungen → Community-Plugins → Durchsuchen → „BRAT").
2. `Strg/Cmd+P` → **BRAT: Add a beta plugin for testing**.
3. `mar65vo187/jarvis` eingeben, Version wie vorgeschlagen lassen, bestätigen.
4. Einstellungen → Community-Plugins → **Jarvis AI (lokal + Top-Cloud)** aktivieren.

### Weg B — Installationshelfer (Windows / macOS / Linux)

1. Den Ordner `obsidian-jarvis` dieses Projekts herunterladen (Code → Download ZIP)
   und **vollständig entpacken**.
2. Windows: `install\JARVIS-INSTALLIEREN.cmd` doppelklicken.
   macOS/Linux: `./install/install.sh /pfad/zu/deinem/Vault`
3. Der Helfer zeigt vorhandene Vaults an, sichert alte Dateien und kopiert
   `main.js`, `manifest.json`, `styles.css` in `.obsidian/plugins/jarvis-ai/`.
4. Obsidian neu laden, Plugin aktivieren.

### Weg C — von Hand

1. Im Vault den Ordner `.obsidian/plugins/jarvis-ai/` anlegen.
2. `main.js`, `manifest.json`, `styles.css` hineinkopieren (aus dem Release oder dem
   Ordner `obsidian-jarvis`).
3. Obsidian neu starten, Plugin aktivieren.

Nach der Installation: `Strg/Cmd+P` → **„Jarvis: Chat öffnen"** oder das ✨-Symbol
in der Seitenleiste.

---

## 4. Einrichtung: lokal (Ollama)

1. [Ollama installieren](https://ollama.com/download) und starten.
2. Ein Modell laden, passend zu deinem Speicher:

   | Dein Rechner | Befehl | Größe | Bemerkung |
   |---|---|---|---|
   | 8 GB RAM, nur CPU | `ollama pull qwen3:4b` | ~2,6 GB | klein, schnell, einfache Aufgaben |
   | 16 GB RAM | `ollama pull qwen3:8b` | ~5 GB | guter Allrounder |
   | 16 GB RAM / GPU | `ollama pull gpt-oss:20b` | ~13 GB | starkes Denken, braucht Platz |
   | 24 GB VRAM | `ollama pull qwen3.6:27b` | ~17 GB | stärkstes Einzelmodell |
   | 32 GB RAM+ | `ollama pull qwen3:30b` | ~19 GB | schnell für seine Größe (MoE) |

3. Für die Bedeutungssuche: `ollama pull nomic-embed-text` (~274 MB, sehr empfehlenswert).
4. In Obsidian: Einstellungen → **Jarvis KI** → *Modelle laden* → Modell wählen.
   Die Kontextgröße 8192 ist ein guter Start.

> **Wichtig für den Desktop:** Damit Obsidian Ollama direkt anfragen darf, einmalig
> die Umgebungsvariable `OLLAMA_ORIGINS=app://obsidian.md,http://localhost,http://127.0.0.1`
> setzen und Ollama neu starten. Der Installationshelfer erledigt das für dich.
> Falls es nicht gesetzt ist, holt Jarvis die Antwort automatisch ohne Streaming —
> funktioniert also trotzdem, nur ohne Live-Tippen.

---

## 5. Einrichtung: Cloud (Top-Modelle)

In den Einstellungen gibt es für jeden Anbieter einen Block. **Aktiv** einschalten,
**API-Schlüssel** einfügen, fertig. Die Schlüssel liegen im Schlüsseltresor von
Obsidian (ab Version 1.11) und nicht im Vault.

| Anbieter | Modell (Vorschlag) | Schlüssel besorgen | Bemerkung |
|---|---|---|---|
| **Claude** (Anthropic) | `claude-opus-5-5` | console.anthropic.com | Führt die Qualitätslisten an, 1 Mio. Token Kontext. Bestes Ergebnis für schwere Aufgaben. |
| | `claude-sonnet-5-5` | | Deutlich günstiger, sehr stark im Alltag. |
| **GPT** (OpenAI) | `gpt-6-astra` | platform.openai.com | Stärkstes OpenAI-Modell. |
| | `gpt-6-luna` | | Günstig und schnell für viel Text. |
| **Gemini** (Google) | `gemini-3.8-flash` | aistudio.google.com | Sehr schnell, großzügiges Gratis-Kontingent. |
| **OpenRouter** | `anthropic/claude-opus-5-5` u. a. | openrouter.ai/keys | Ein Schlüssel für fast alle Modelle. |
| **Eigener Dienst** | z. B. `llama3.1:8b` | — | Alles, was `…/v1/chat/completions` spricht (LM Studio, vLLM, Groq, DeepSeek). |

Mit **„Modelle laden"** holt Jarvis die echte Liste deines Kontos — so funktioniert
das Plugin auch dann, wenn sich Modellnamen ändern.

**Kosten:** Unter jeder Cloud-Antwort steht eine grobe Schätzung. Für Dauerbetrieb
ist `⚡ Auto` die beste Einstellung: Alltagsfragen bleiben lokal, teure Cloud-Modelle
werden nur bei schwierigen Aufgaben benutzt.

---

## 6. Bedienung

**Befehls-Palette** (`Strg/Cmd+P`):

| Befehl | Wirkung |
|---|---|
| Jarvis: Chat öffnen | Chat im rechten Bereich öffnen |
| Jarvis: Diese Notiz zusammenfassen (lokal) | Zusammenfassung ohne Cloud |
| Jarvis: Diese Notiz zusammenfassen (bestes Cloud-Modell) | Zusammenfassung mit Top-Modell |
| Jarvis: Aufgaben aus dieser Notiz ableiten | Aufgabenliste `- [ ]` |
| Jarvis: Markierten Text erklären/verbessern | Auswahl geht als Frage in den Chat |
| Jarvis: Auswahl mit Cloud-Modell überarbeiten und ersetzen | ersetzt die Auswahl direkt |
| Jarvis: Frage an meinen Vault stellen | Chat mit leerem Eingabefeld |
| Jarvis: Wissensindex neu aufbauen | Notizen neu einlesen |
| Jarvis: Lokales Modell aus dem Speicher entladen | gibt RAM frei |
| Jarvis: Vault jetzt sichern | GitHub-Sicherung mit Vorschau |
| Jarvis: Vault wiederherstellen (Vorschau) | GitHub → Vault, mit Vorschaudialog |
| Jarvis: Verbindungen testen | Diagnosebericht für Ollama, Cloud, GitHub |

**Im Chat:** Modus links oben (Lokal/Auto/Cloud), daneben dein Modell. Unten
„Was soll Jarvis tun?" (Vault-Frage, freies Gespräch, Zusammenfassen, Aufgaben,
Verbessern, Übersetzen, Plan, Gegenprüfung, gründlich) und die Option *geöffnete
Notiz einbeziehen*. Antworten haben Knöpfe: **Kopieren**, **In Notiz einfügen**,
**Neue Notiz**, **Besser machen (Cloud)**.

Neue Notizen aus Antworten landen im Ordner `Jarvis-Ausgaben` (einstellbar).

---

## 7. GitHub-Anbindung (Sichern und Wiederherstellen)

### Einmal einrichten

1. Auf GitHub ein **neues Repository** anlegen — am besten **privat**, z. B. `mein-vault`.
2. Feingranularen Token erstellen: <https://github.com/settings/personal-access-tokens>
   - *Repository access*: nur dieses Repository
   - *Permissions* → **Contents: Read and write**
3. In Obsidian: Einstellungen → **Jarvis KI** → Abschnitt **GitHub**
   - *GitHub-Sicherung aktiv* ✅
   - **Owner** (dein Benutzername), **Repository** (Name), **Branch** (`main`)
   - **GitHub-Token** einfügen
   - *Unterordner im Repository*: leer lassen oder z. B. `vault`
4. **Verbindung testen** → muss „✅ Verbunden" melden.
5. **Jetzt sichern** → es erscheint eine Vorschau (neu / geändert / gelöscht) und
   danach ein einziger Commit.

### Wie gesichert wird

- Ein Commit pro Sicherung, mit Datum und Anzahl der Dateien.
- Nur geänderte Dateien werden hochgeladen (Vergleich über den Git-Hash) — große
  Vaults sind dadurch schnell.
- Standard: **nur Markdown-Notizen**. Anhänge lassen sich zuschalten, kosten aber
  viel Übertragung.
- Ausgeschlossen sind immer: `.git`, `.trash`, `node_modules`, der Plugin-Zwischenspeicher.
- Zusätzliche Ausschlüsse (Ordner oder Dateinamen) kannst du selbst eintragen.
- **Automatik**: „Automatisch sichern (Minuten)" (z. B. 60) und/oder „Nach Änderungen
  sichern" (sammelt Änderungen, frühestens alle 5 Minuten ein Commit).

### Wiederherstellen

„Vault wiederherstellen (Vorschau)" zeigt erst die Liste der Dateien und schreibt
dann nur, was sich unterscheidet. Lokale Dateien, die in GitHub fehlen, bleiben
erhalten — außer du schaltest *Beim Wiederherstellen lokale Dateien löschen* ein.
So ziehst du deinen Vault auf einen zweiten Rechner.

> Hinweis: Der Vault wird **nicht** automatisch synchron gehalten wie bei Obsidian
> Sync. Es ist eine versionierte Sicherung plus Wiederherstellung — genau das, was
> gegen Datenverlust und für den Zweitrechner hilft. Konflikte kann es dadurch nicht
> geben, weil immer du entscheidest, wann gesichert oder geholt wird.

---

## 8. Datenschutz und Daten

- **Lokal-Modus**: keine Inhalte verlassen den Rechner. Alle Anfragen gehen an
  `127.0.0.1:11434` (Ollama).
- **Cloud-Modus**: Es werden nur die Nachricht plus die ausgewählten Notiz-Ausschnitte
  übertragen. Kein Vault-Upload, keine automatische Weitergabe des Verlaufs.
- Notizen mit `ki-privat: true` (oder `jarvis-privat: true`) werden nie gelesen.
- Der Wissensindex liegt als Datei unter `.obsidian/plugins/jarvis-ai/cache/` und
  enthält Textausschnitte deiner Notizen — beim GitHub-Backup wird er ausgelassen.
- Chatverlauf liegt in der Plugin-Datei `data.json` (letzte 25 Unterhaltungen).
- API-Schlüssel: Obsidian-Schlüsseltresor, sonst `data.json` (dann unverschlüsselt —
  die Einstellungen sagen dir, welcher Fall gilt).

---

## 9. Wenn etwas nicht klappt

| Symptom | Ursache / Lösung |
|---|---|
| „Keine Verbindung … Dienst läuft nicht" | Ollama starten (`ollama serve` oder App). Adresse prüfen: `http://127.0.0.1:11434`. |
| Lokale Antworten dauern beim ersten Mal sehr lange | Das Modell wird geladen. „Modell im Speicher halten" auf `30m` setzen, oder kleineres Modell wählen. |
| Antwort kommt erst am Ende (kein Live-Tippen) | `OLLAMA_ORIGINS` nicht gesetzt — siehe Abschnitt 4; Antwort funktioniert trotzdem. |
| „Zugang abgelehnt (401/403)" | Schlüssel falsch/eingeschränkt. Bei GitHub: Contents = Read and write. |
| „Limit erreicht (429)" | Kontingent erschöpft — kurz warten oder anderes Modell. |
| „Modell nicht gefunden (404)" | In den Einstellungen *Modelle laden* und ein vorhandenes Modell auswählen. |
| Wissenssuche findet nichts | Index neu aufbauen, ausschließende Ordner prüfen, konkrete Stichworte aus der Notiz nennen. `ollama pull nomic-embed-text` verbessert die Treffer deutlich. |
| Cloud-Knopf fehlt | Mindestens einen Cloud-Anbieter auf *Aktiv* setzen und Schlüssel eintragen. |
| GitHub: „Branch existiert noch nicht" | Normal beim ersten Mal — die Sicherung legt ihn an. |
| Wiederherstellen bricht ab | Branch/Repo/Token prüfen; Vorschau zeigt die Ursache. |

**Diagnose:** Einstellungen → Jarvis KI → *Alle Verbindungen prüfen* zeigt Ollama,
Cloud-Anbieter, GitHub und den Indexstand in einem Bericht.

---

## 10. Grenzen (ehrlich gesagt)

- Das Plugin trainiert **kein** Modell. Es lenkt vorhandene Modelle mit deinem
  Notizwissen. Kleine lokale Modelle bleiben kleinen lokalen Modellen — die
  Cloud-Modelle sind deutlich klüger, kosten aber Geld.
- Quellenangaben sind Belege für benutzten Kontext, kein Beweis für jede Aussage.
  Bei wichtigen Entscheidungen am Original prüfen.
- Nur Markdown-Notizen werden gelesen. PDFs, Bilder oder Anhänge nicht.
- Kein Internet-Zugriff für das Modell, keine Kalender-/Mail-Aktionen, kein
  selbstständiges Arbeiten bei geschlossenem Obsidian.
- GitHub-Sicherung ist eine Sicherung, kein Live-Sync.
- Die automatischen Tests laufen gegen nachgebaute Anbieter-Schnittstellen
  (echte HTTP-Server, echte Git-Objekt-Hashes). Der erste echte Aufruf findet auf
  deinem Rechner statt — dafür ist der Verbindungstest da. Details: [PRUEFBERICHT.md](PRUEFBERICHT.md).

---

## 11. Für Entwickler

```bash
cd obsidian-jarvis
npm install
npm run typecheck   # TypeScript prüfen
npm test            # 63 Tests (Anbieter, Routing, Index, GitHub, Oberfläche, fertiges Bündel)
npm run build       # erzeugt main.js
```

Aufbau:

```
src/
  main.ts                Plugin-Einstieg, Befehle, GitHub-Automatik, Diagnose
  brain.ts               Modellwahl, Presets, automatisches Ausweichen
  settings.ts            Einstellungen + Oberfläche
  providers/             ollama | openai-compat | anthropic | gemini
  rag/                   vault-index.ts (Suche), prompt.ts (Prompts)
  chat/                  view.ts (Oberfläche), assistant.ts (Ablauf), session.ts
  github/                client.ts (REST), sync.ts (Sichern/Wiederherstellen)
  util/                  http.ts (Streaming + CORS-Ersatzweg), format.ts
  obsidian-bridge.ts     Vault-Zugriff, Zwischenspeicher, Embeddings
tests/                   Tests inkl. nachgebauter Obsidian-Schnittstelle
```

Beitragen ist willkommen — bitte `npm run check` laufen lassen.
