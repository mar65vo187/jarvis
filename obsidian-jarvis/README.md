# Jarvis AI für Obsidian — lokal, online und lernfähig

Ein KI-Assistent, der direkt in Obsidian lebt: Er kennt deine Notizen, antwortet mit
Quellenangaben, kann komplett auf deinem Rechner laufen (Ollama) — und wenn er mehr
Qualität braucht, holt er sich die stärksten Cloud-Modelle. **Aus deren Antworten lernt
er dauerhaft**: Er speichert das Gelernte, nutzt es bei späteren Fragen, und baut daraus
ein besseres lokales Modell. Dazu eine echte GitHub-Anbindung für deinen Vault.

**Neu in 2.1 — Jarvis handelt:** Er benutzt Werkzeuge. Er sucht im Internet, liest
Seiten, liest und schreibt Notizen, rechnet, liest Dateien, führt auf dem Desktop Befehle
aus, liest Dateien und Aufgaben aus deinem GitHub-Repository, findet Modelle auf
HuggingFace, löst n8n-Workflows aus und bindet fremde MCP-Server an. Zwei neue Modi
kommen dazu: **Maximum** (immer die stärksten Modelle, mit Prüflauf) und **Orakel**
(mehrere Top-Modelle prüfen eine Antwort, die beste Fassung gewinnt).

| | |
|---|---|
| **Plugin-Name** | Jarvis AI (lokal + Top-Cloud) |
| **Plugin-Kennung** | `jarvis-ai` |
| **Version** | 2.1.2 |
| **Voraussetzung** | Obsidian ab 1.5 (Desktop und Mobil) |
| **Automatische Tests** | 165 Tests, alle grün (siehe [PRUEFBERICHT.md](PRUEFBERICHT.md)) |

---

## 1. Die drei Betriebsarten

| Modus | Was passiert | Wann sinnvoll |
|---|---|---|
| 🏠 **Lokal** | Nur Ollama auf deinem Rechner. Keine Daten verlassen den PC. | Vertrauliches, Alltagsfragen, kein Internet |
| ⚡ **Auto** | Erst lokal. Ist die lokale Antwort zu schwach (oder läuft kein Modell), übernimmt automatisch ein Top-Cloud-Modell — **und Jarvis lernt daraus**. | Standardbetrieb: günstig, privat, wird mit der Zeit besser |
| ☁️ **Cloud** | Immer das stärkste Modell (Claude Opus 5.5, GPT-6 Astra, Gemini 3.8 Flash, OpenRouter). | Schwere Aufgaben, in denen Qualität alles ist |

---

## 2. Lernfähig: wie die lokale KI besser wird

Das ist der Kern von Version 2.0. Der Ablauf bei jeder Frage:

```
Frage
  │
  ├─ Wissenssuche im Vault        → Notiz-Ausschnitte  [Q1], [Q2] …
  ├─ Gelerntes Wissen            → Lektionen          [W1], [W2] …
  │
  ├─ Lokale KI antwortet zuerst (privat, schnell, kostenlos)
  │
  ├─ Qualitätsmessung: Wie viel von dem, was in den Quellen steht,
  │  kommt in der Antwort wirklich vor? (Quellenabdeckung in %)
  │  Ausweich-Antworten ("Als KI-Modell kann ich …") werden erkannt.
  │
  ├─ Zu schwach? → Cloud-Modell übernimmt (Aufwertung)
  │        └─ daraus wird gelernt: Antwort gespeichert, Qualität dokumentiert
  │
  └─ Beim nächsten Mal: das Gelernte steht im Prompt der lokalen KI
     → sie antwortet besser → die Cloud wird seltener gebraucht
```

### Drei Ebenen des Lernens

**1. Lernspeicher (sofort wirksam)**
Jede gelernte Cloud-Antwort wird als „Lektion" gespeichert: Frage, Antwort, Herkunft
(Modell), benutzte Notizen, Stichworte. Passende Lektionen gehen bei späteren Fragen als
`[W1], [W2]` in den Prompt — die lokale KI antwortet damit so, wie es das starke Modell
getan hat. Die Lektionen liegen doppelt:
- `cache/learning.json` (schnell, im Plugin-Ordner)
- **`Jarvis Gedächtnis/` als normale Markdown-Notizen im Vault** — dadurch nimmt die
  GitHub-Sicherung sie automatisch mit. Du kannst sie lesen, ändern und löschen.

**2. Korrekturen (verbindlich)**
Wenn du eine Antwort korrigierst („Korrigieren"-Knopf), gilt ab dann deine Fassung: Sie
wird bevorzugt zitiert, als Regel gespeichert und in das lokale Modell eingebaut.

**3. Die Notizen als dauerhafte Quelle**
Das Gelernte steht als Markdown in `Jarvis Gedächtnis/`. Fehlt der schnelle Speicher
`cache/learning.json` — nach einer Neuinstallation, auf einem anderen Rechner oder wenn
der Zwischenspeicher geleert wurde — holt Jarvis das Wissen beim Start automatisch
aus den Notizen zurück (zusätzlich per Befehl „Gelerntes aus den Notizen
wiederherstellen"). Über die GitHub-Sicherung wandert es mit in dein Repository: Dein
Wissen gehört dir, nicht dem Plug-in-Ordner.

**4. Destillation (dauerhaft im lokalen Modell)**
„Lernmodell bauen" (Knopf 🎓 oder Befehl) schreibt die besten gelernten Fragen/Antworten
und deine Regeln in ein **neues Ollama-Modellprofil** — z. B. `jarvis-brain-v3` — und macht
es zu deinem lokalen Standardmodell. Danach trägt dein lokales Modell das Gelernte
permanent in sich, auch ohne dass Lektionen in den Prompt passen müssen.

> **Ganz ehrlich:** Es werden dabei **keine Modellgewichte trainiert** und nichts
> heruntergeladen. Ein echtes Finetuning ist auf einem normalen Rechner nicht seriös
> machbar. Was hier passiert, ist das, was wirklich funktioniert und überprüfbar bleibt:
> gespeichertes Wissen, verbindliche Regeln, Beispiel-Dialoge im Modellprofil, bessere
> Quellenwahl und eine messbare Qualitätskurve. Alles ist nachvollziehbar, änderbar,
> löschbar.

### Was du siehst

- Unter jeder Antwort: **Qualität in %** (Quellenabdeckung) und bei Aufwertung
  „vorher 22 % → jetzt 91 %".
- **🧠 gelernt** an Antworten, die als Wissen gespeichert wurden.
- Knöpfe: **Hilfreich**, **Nicht hilfreich**, **Korrigieren** — dein Urteil steuert,
  was bevorzugt verwendet und was nie wieder benutzt wird.
- In der Kopfzeile: **„🧠 12 Lektion(en) · Qualität 78 % · 3 neu"**.
- Bericht (Knopf 🧠 oder Befehl): Lektionen, Korrekturen, Qualitätsverlauf pro Frage,
  Modellstatistik (Aufrufe, Fehler, Dauer).

### Voreinstellungen fürs Lernen

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Lernen aktiv | an | alles abschaltbar |
| Wann merken? | automatisch | `nachfragen` zeigt „🧠 Merken"-Knopf, `aus` speichert nichts |
| Woraus lernen? | nur wenn lokal nicht reichte | sparsam; `aus jeder Cloud-Antwort` lernt mehr |
| Qualitätsschwelle | 0,55 | darunter gilt die lokale Antwort als zu schwach (0,5–0,6 empfohlen) |
| Lektionen im Prompt | 3 | mehr = stärkerer Effekt, längere Anfragen |
| Gelerntes als Notizen | an | Markdown im Vault, inklusive GitHub-Sicherung |
| Gedächtnisordner | `Jarvis Gedächtnis` | wird bei der Vault-Suche nicht doppelt gelesen |
| Automatisch verbessern | aus | z. B. `25`: nach 25 neuen Lektionen entsteht automatisch ein neues Profil |
| Beispiele im Modell | 8 | mehr Beispiele = größeres Profil, stärkerer Effekt |
| Regeln aus Korrekturen | leer | eine Zeile pro Regel, fest im lokalen Modell |

---

## 3. Was das Plugin noch kann

- **Fragen an den Vault** mit Quellenangaben `[Q1]` als anklickbare Verweise.
- **Hybride Suche**: lokale Embeddings + Stichwortsuche (BM25) — funktioniert auch ohne
  Embedding-Modell.
- **Aufgaben aus Obsidian**: zusammenfassen, Aufgaben ableiten, Text verbessern,
  übersetzen, Plan, Gegenprüfung, „gründlich" (Entwurf + Selbstprüfung).
- **Auswahl im Editor** erklären bzw. per Cloud überarbeiten und direkt ersetzen.
- **Private Notizen** (`ki-privat: true`) und ausgeschlossene Ordner werden nie gelesen.
- **Kostenschätzung** pro Cloud-Antwort (grob, ohne Gewähr) und Tokenzahlen.
- **GitHub**: Vault als echte Commits sichern, mit Vorschau wiederherstellen.
- **Werkzeuge**: Internet, GitHub, HuggingFace, n8n, Rechner, Dateien, MCP (Abschnitt 4).

---

## 4. Werkzeuge — Jarvis handeln lassen

Jarvis kann nicht nur antworten, sondern **etwas tun**. Jedes Werkzeug ist einzeln
freigeschaltet, alles Schreibende und Ausführende ist standardmäßig **aus**. Zu sehen ist
jeder Schritt in der Antwort (Schalter „Werkzeugschritte anzeigen").

| Werkzeug | Was es tut | Freigabe |
|---|---|---|
| `vault_search`, `vault_read`, `vault_list` | Notizen durchsuchen, lesen, auflisten | immer |
| `vault_write`, `vault_append` | Notizen anlegen und ergänzen | „Notizen anlegen und ändern" |
| `web_search` | Internetsuche (Tavily, Brave, SearXNG, DuckDuckGo) | „Internet" |
| `web_read` | Internetseite lesen und in Text wandeln | „Internet" |
| `calculate` | Rechnen (Punkt vor Strich, Klammern, `%`, `^`, deutsche Zahlen wie `1.000,50`) | immer |
| `run_command` | Programme starten (git, npm, Skripte) — **nur Desktop**, mit Sperrliste | „Befehle auf dem Rechner" |
| `read_file`, `write_file` | Dateien außerhalb des Vaults — **nur Desktop** | „Dateien" |
| `github_file`, `github_tree`, `github_search`, `github_issues` | Dateien im verbundenen Repository lesen, Baum ansehen, in Code suchen, Aufgaben lesen | GitHub-Anbindung |
| `github_write` | Datei im Repository ändern (mit Commit) | „GitHub: Dateien schreiben" |
| `hf_search`, `hf_info` | Modelle, Datensätze und Apps auf HuggingFace finden und prüfen | immer (Schlüssel optional) |
| `n8n_run` | n8n-Workflow über Webhook auslösen | „n8n-Webhook" |
| `mcp_<server>_<werkzeug>` | Werkzeuge fremder MCP-Server (Dateien, Browser, Datenbanken …) | „MCP" |
| `note_current` | Die gerade geöffnete Notiz samt markiertem Text | immer |
| `note_links` | Verweise einer Notiz: was sie verlinkt und was auf sie verweist (Backlinks) | immer |
| `vault_tags` | Alle Tags im Vault, häufigste zuerst | immer |
| `note_open` | Öffnet eine Notiz in Obsidian (z. B. nach dem Anlegen) | immer |
| `daily_note` | Tagesnotiz von heute lesen | immer |
| `daily_append` | Eintrag an die Tagesnotiz anhängen | „Notizen anlegen und ändern" |
| `editor_replace` | Markierten Text in der offenen Notiz ersetzen | „Notizen anlegen und ändern" |

Die Obsidian-Werkzeuge kennen die geöffnete Notiz, die Auswahl im Editor, Tagesnotizen
(„Tagesnotizen-Ordner" einstellen, z. B. `Journal`), Verweise und Tags — damit kann Jarvis
Dinge, die nur von innen funktionieren.

**So läuft ein Werkzeugeinsatz ab:** Jarvis bekommt die Werkzeugliste in seine
Anweisung, antwortet in einer Runde mit einem Werkzeugblock, das Plugin führt ihn
wirklich aus, das Ergebnis geht zurück ins Modell — und erst dann entsteht die Antwort.
Falsche oder erfundene Werkzeugnamen werden erkannt und korrigiert, statt still zu
scheitern. Nach `maxSteps` Runden (Standard 4) bricht die Schleife ab und sagt es dir.

### Die zwei neuen Modi

| Modus | Was passiert |
|---|---|
| ⚡ **Maximum** | Immer das stärkste verfügbare Cloud-Modell, Werkzeuge dürfen ran, und am Ende prüft Jarvis seine eigene Antwort noch einmal. Für schwere Aufgaben. |
| 🔮 **Orakel** | Ein Top-Modell schreibt, **andere** Top-Modelle prüfen (Fehler, Lücken, Risiken), das erste Modell schreibt daraus die geprüfte Endfassung. Du siehst „🔮 von mehreren Modellen geprüft". |

Ein Selbsttest in den Einstellungen („Werkzeuge testen") ruft die Werkzeuge **wirklich**
auf (Rechnen, Vault, Internet, GitHub, HuggingFace, n8n, MCP) und zeigt dir, was
funktioniert.

---

## 5. Installation

### Weg A — über GitHub (empfohlen, mit Updates)

1. Community-Plugin **BRAT** installieren (Einstellungen → Community-Plugins → Durchsuchen → „BRAT").
2. `Strg/Cmd+P` → **BRAT: Add a beta plugin for testing** → `mar65vo187/jarvis` → bestätigen.
3. Einstellungen → Community-Plugins → **Jarvis AI (lokal + Top-Cloud)** aktivieren.

### Weg B — Installationshelfer

Ordner `obsidian-jarvis` herunterladen und entpacken.
Windows: `install\JARVIS-INSTALLIEREN.cmd` doppelklicken.
macOS/Linux: `./install/install.sh /pfad/zu/deinem/Vault`

### Weg C — von Hand

`main.js`, `manifest.json`, `styles.css` nach `.obsidian/plugins/jarvis-ai/` kopieren,
Obsidian neu laden, Plugin aktivieren.

Danach: `Strg/Cmd+P` → **„Jarvis: Chat öffnen"**.

---

## 6. Einrichtung: lokal (Ollama)

1. [Ollama](https://ollama.com/download) installieren und starten.
2. Modell wählen (nach Speicher):

   | Rechner | Befehl | Größe |
   |---|---|---|
   | 8 GB RAM, nur CPU | `ollama pull qwen3:4b` | ~2,6 GB |
   | 16 GB RAM | `ollama pull qwen3:8b` | ~5 GB |
   | 16 GB RAM / GPU | `ollama pull gpt-oss:20b` | ~13 GB |
   | 24 GB VRAM | `ollama pull qwen3.6:27b` | ~17 GB |
   | 32 GB RAM+ | `ollama pull qwen3:30b` | ~19 GB |

3. Für die Bedeutungssuche: `ollama pull nomic-embed-text` (~274 MB, sehr empfohlen).
4. In Obsidian: Einstellungen → **Jarvis KI** → *Modelle laden* → Modell wählen.

> **Für Desktop-Obsidian:** einmalig `OLLAMA_ORIGINS=app://obsidian.md,http://localhost,http://127.0.0.1`
> setzen und Ollama neu starten, damit live mitgeschrieben wird. Ohne diese Variable holt
> Jarvis die Antwort automatisch am Stück — funktioniert trotzdem. Der Installer erledigt das.

---

## 7. Einrichtung: Cloud (Top-Modelle)

**Aktiv** einschalten, **API-Schlüssel** einfügen, fertig. Schlüssel liegen im
Schlüsseltresor von Obsidian (ab 1.11), nicht im Vault.

| Anbieter | Vorschlag | Schlüssel | Bemerkung |
|---|---|---|---|
| **Claude** | `claude-opus-5-5` | console.anthropic.com | Führt die Qualitätslisten an — die beste Quelle zum Lernen |
| | `claude-sonnet-5-5` | | günstiger, sehr stark |
| **GPT** | `gpt-6-astra` | platform.openai.com | stärkstes OpenAI-Modell |
| | `gpt-6-luna` | | günstig, für viel Text |
| **Gemini** | `gemini-3.8-flash` | aistudio.google.com | sehr schnell, Gratis-Kontingent |
| **OpenRouter** | `anthropic/claude-opus-5-5` u. a. | openrouter.ai/keys | ein Schlüssel, fast alle Modelle |
| **HuggingFace** | z. B. `Qwen/Qwen3-8B` | huggingface.co/settings/tokens | Inference-Router: ein Schlüssel, sehr viele offene Modelle |
| **n8n** | `jarvis` | — | eigener Workflow als Modellantwort (`/v1/chat/completions`) |
| **Eigener Dienst** | z. B. `llama3.1:8b` | — | alles mit `/v1/chat/completions` (LM Studio, vLLM, Groq, DeepSeek) |

Bei jedem Cloud-Anbieter gibt es zusätzlich **„Nachdenken"** (Denk-Stufe: aus, wenig,
mittel, hoch, maximal). Ist sie eingeschaltet, bekommt das Modell die passenden Felder
(`reasoning_effort`, `thinking`, `generationConfig`); scheitert der Aufruf damit, wiederholt
Jarvis die Anfrage automatisch ohne diese Felder.

Mit **„Modelle laden"** holt Jarvis die echte Liste deines Kontos.
Für Dauerbetrieb ist `⚡ Auto` ideal: Alltag lokal, Cloud nur wenn nötig — **und genau
diese Cloud-Antworten machen deine lokale KI besser.**

---

## 8. Bedienung

**Befehls-Palette** (`Strg/Cmd+P`):

| Befehl | Wirkung |
|---|---|
| Jarvis: Chat öffnen | Chat im rechten Bereich |
| Jarvis: Diese Notiz zusammenfassen (lokal / Cloud) | je nach gewünschter Qualität |
| Jarvis: Aufgaben aus dieser Notiz ableiten | Aufgabenliste `- [ ]` |
| Jarvis: Markierten Text erklären/verbessern | Auswahl als Frage |
| Jarvis: Auswahl mit Cloud-Modell überarbeiten und ersetzen | ersetzt direkt |
| Jarvis: Lernen: Was hat Jarvis gelernt? | Bericht mit Qualitätsverlauf |
| Jarvis: Lernen: Lokales Modell aus Gelerntem verbessern | Destillation starten |
| Jarvis: Lernen: Gelerntes als Notizen im Vault ablegen | Markdown-Dateien nachziehen |
| Jarvis: Lernen: Gelerntes aus den Notizen wiederherstellen | Wissen nach Neuinstallation zurückholen |
| Jarvis: Lernen: Gelerntes Wissen löschen | Lernspeicher leeren (Notizen bleiben, bis du sie löschst) |
| Jarvis: Wissensindex neu aufbauen | Notizen neu einlesen |
| Jarvis: Lokales Modell aus dem Speicher entladen | RAM freigeben |
| Jarvis: Vault jetzt sichern / wiederherstellen | GitHub mit Vorschau |
| Jarvis: Mit dem Konto verbinden (Geräte-Code) / Verbindung und Rechte prüfen | GitHub-Anmeldung |
| Jarvis: Prüfen, ob neuere Inhalte bereitstehen | GitHub-Stand mit diesem Rechner vergleichen |
| Jarvis: Verbindungen testen | Diagnosebericht |

**Im Chat:** Modus (Lokal/Auto/Cloud), Modellwahl, Aufgabe (Vault-Frage, Gespräch,
Zusammenfassen, Aufgaben, Verbessern, Übersetzen, Plan, Gegenprüfung, gründlich),
„geöffnete Notiz einbeziehen". Antwort-Knöpfe: Kopieren, In Notiz einfügen, Neue Notiz,
Besser machen (Cloud), Hilfreich, Nicht hilfreich, Korrigieren.
Kopfzeile: 🎓 Lernmodell bauen · 🧠 Lernbericht · ⚙️ Einstellungen.

---

## 9. GitHub-Anbindung

### Einmal einrichten — Weg A: mit deinem Konto verbinden (empfohlen)

Kein Token-Basteln mehr. Jarvis meldet sich selbst bei deinem GitHub-Konto an:

1. **Einmalig** eine OAuth-App anlegen (dauert eine Minute):
   <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**
   - Name: `Jarvis AI (Obsidian)`
   - Homepage: `https://github.com/mar65vo187/jarvis`
   - Authorization callback URL: `http://localhost` (wird nicht benutzt, muss aber gefüllt sein)
   - Haken bei **Enable Device flow**
2. Die angezeigte **Client-ID** kopieren und in Obsidian unter
   Einstellungen → **Jarvis KI** → **GitHub** → *OAuth-Client-ID* eintragen.
3. **Mit GitHub verbinden** drücken: Jarvis zeigt einen Code an, du gibst ihn auf
   <https://github.com/login/device> ein, bestätigst — fertig. Der Schlüssel kommt in
   den Obsidian-Schlüsseltresor (oder nach `data.json`, wenn es keinen gibt).
4. Repository wählen: **Repositories laden** → aus der Liste wählen (Owner, Name und
   Branch werden automatisch eingetragen) — oder **Neues Repository anlegen**, dann legt
   Jarvis ein privates Repository inklusive README an und trägt es als Ziel ein.
5. **Rechte prüfen** zeigt dir, als welcher Benutzer Jarvis angemeldet ist und ob der
   Schlüssel Inhalte schreiben darf. Danach **Jetzt sichern** (mit Vorschau).

Du brauchst die OAuth-App nur **einmal** — danach genügt der Knopf „Mit GitHub verbinden",
auch auf weiteren Rechnern. **Trennen** entfernt den gespeicherten Schlüssel sofort.

### Einmal einrichten — Weg B: Token von Hand

1. Auf GitHub ein **privates Repository** anlegen, z. B. `mein-vault`.
2. Feingranularen Token erstellen (<https://github.com/settings/personal-access-tokens>):
   *Repository access* = nur dieses Repo, **Contents: Read and write**.
3. Einstellungen → **Jarvis KI** → **GitHub**: aktiv, Owner, Repository, Branch (`main`),
   Token einfügen → **Verbindung testen** → **Jetzt sichern** (mit Vorschau).

### Verhalten

- Ein Commit pro Sicherung, nur geänderte Dateien (Git-Hash-Vergleich).
- **Konflikte löst Jarvis selbst**: hat ein zweiter Rechner inzwischen hochgeladen,
  meldet GitHub „non-fast-forward" — Jarvis holt den neuen Stand und versucht es
  automatisch erneut, statt mit einer kryptischen Meldung abzubrechen.
- **Neuer-Stand-Prüfung**: auf Wunsch meldet Jarvis beim Start, wenn auf GitHub neuere
  Commits liegen als hier gesichert wurden (Einstellung *Beim Start prüfen*, oder Befehl
  *GitHub: Prüfen, ob neuere Inhalte bereitstehen*). Überschrieben wird nie automatisch.
- GitHub Enterprise: unter **Werkzeuge → GitHub-API-Adresse** die eigene Adresse
  eintragen — Sicherung, Wiederherstellung und Werkzeuge nutzen sie dann gemeinsam.

- Ein Commit pro Sicherung, nur geänderte Dateien (Git-Hash-Vergleich).
- Immer ausgeschlossen: `.git`, `.trash`, `node_modules`, Plugin-Zwischenspeicher.
- Standard: nur Markdown — **die gelernten Notizen und der Vault-Index sind dadurch mit
  dabei** und überleben Rechnerwechsel und Neuinstallation.
- Automatik: Zeitplan (Minuten) und/oder „nach Änderungen" (frühestens alle 5 Minuten).
- Wiederherstellen zeigt erst die Dateiliste und schreibt nur Unterschiede.

> Der Vault wird nicht automatisch live synchronisiert wie bei Obsidian Sync — es ist
> eine versionierte Sicherung mit Wiederherstellung, und du entscheidest wann.

---

## 10. Datenschutz und Daten

- **Lokal-Modus**: alles bleibt auf `127.0.0.1` (Ollama).
- **Cloud-Modus**: übertragen werden nur die Nachricht, die ausgewählten Notiz-Ausschnitte
  und passende Lektionen — kein Vault-Upload, kein Verlauf.
- Notizen mit `ki-privat: true` werden nie gelesen.
- Gelerntes liegt in `cache/learning.json` **und** als Markdown im konfigurierten
  Gedächtnisordner (dadurch in GitHub-Backups enthalten). Fehlt der Zwischenspeicher,
  wird das Wissen beim Start aus den Notizen wiederhergestellt.
- API-Schlüssel im Obsidian-Schlüsseltresor, sonst in `data.json` (die Einstellungen
  sagen dir, welcher Fall gilt).

---

## 11. Wenn etwas nicht klappt

| Symptom | Lösung |
|---|---|
| „Keine Verbindung … Dienst läuft nicht" | Ollama starten; Adresse `http://127.0.0.1:11434` prüfen |
| Erste lokale Antwort dauert lange | Modell wird geladen — „Modell im Speicher halten" auf `30m` |
| Antwort kommt erst am Ende | `OLLAMA_ORIGINS` setzen (Abschnitt 5) — funktioniert trotzdem |
| Lokale Antworten bleiben schwach | Qualitätsschwelle prüfen, Lektionen ansehen, „Lernmodell bauen", ggf. größeres Basismodell |
| „Verbessern nicht möglich" | Es braucht mindestens eine geeignete Lektion (Antwort ≥ 40 Zeichen, nicht als schlecht bewertet) |
| `jarvis-brain-vX` erscheint nicht | Ollama aktualisieren; der Diagnosebericht sagt es dir |
| 401/403 | Schlüssel prüfen; bei GitHub Contents = Read and write |
| „Keine OAuth-Client-ID eingetragen" | Einmalig OAuth-App anlegen (Abschnitt 9, Weg A) — oder Weg B mit Token von Hand |
| „Code ist abgelaufen" | Erneut auf **Mit GitHub verbinden** — der Code gilt nur wenige Minuten |
| „Repository … gibt es bereits" | Anderen Namen wählen oder das bestehende Repository aus der Liste wählen |
| „Repository hat sich während der Sicherung erneut geändert" | Erst **Wiederherstellen** (Vorschau), dann erneut sichern |
| 429 | Kontingent erschöpft — warten oder Modell wechseln |
| Wissenssuche findet nichts | Index neu aufbauen, Ausschlüsse prüfen, `ollama pull nomic-embed-text` |
| Gelerntes versehentlich drin | „Lernen: Was hat Jarvis gelernt?" → schlecht bewerten oder löschen; Markdown-Notiz direkt bearbeiten/löschen |

**Diagnose:** Einstellungen → Jarvis KI → *Alle Verbindungen prüfen*.

---

## 12. Grenzen (ehrlich)

- **Kein Trainieren von Modellgewichten.** Das Lernen sind gespeicherte Antworten,
  Regeln und Beispiel-Dialoge im Modellprofil. Ein kleines lokales Modell bleibt dadurch
  spürbar besser für *deine* Themen, aber nicht so klug wie ein Cloud-Modell.
- Die Qualitätsmessung (Quellenabdeckung) ist ein **Signal, keine Wahrheit**. Sie erkennt
  zuverlässig fehlende Kernaussagen und Ausweich-Floskeln, aber keine inhaltlichen Fehler
  in schöner Formulierung. Deshalb gibt es Bewerten und Korrigieren.
- Nur Markdown-Notizen werden gelesen (keine PDFs/Bilder).
- Werkzeuge, die auf Programme oder Dateien außerhalb des Vaults zugreifen, laufen nur
  auf dem Desktop (wie Obsidian selbst); auf dem Tablet bleiben Internet-, GitHub-,
  HuggingFace-, n8n- und Vault-Werkzeuge verfügbar.
- Kein Arbeiten bei geschlossenem Obsidian, keine Kalender-/Mail-Aktionen von sich aus
  (n8n-Workflows können das übernehmen).
- GitHub ist eine Sicherung und ein Werkzeug, kein Live-Sync in Echtzeit.

---

## 13. Für Entwickler

```bash
cd obsidian-jarvis
npm ci
npm run typecheck   # TypeScript strict
npm test            # 165 Tests; baut vorher automatisch das Bündel
npm run build       # erzeugt main.js
```

```
src/
  main.ts                Plugin-Einstieg, Befehle, GitHub-Automatik, Destillation, Diagnose
  brain.ts               Modellwahl, Presets, automatisches Ausweichen
  settings.ts            Einstellungen + Oberfläche
  providers/             ollama | openai-compat | anthropic | gemini (mit Denk-Stufen)
  tools/                 types | protocol (Werkzeugblöcke) | agent (Schleife) | registry
                         (Vault, Rechner, Shell, Dateien) | web (Suche/Seiten lesen) |
                         dienste (GitHub, HuggingFace, n8n) | obsidian (Notiz, Auswahl,
                         Backlinks, Tags, Tagesnotiz) | mcp (fremde Werkzeuge)
  rag/                   vault-index.ts (Suche), prompt.ts (Prompts inkl. Lektionen)
  learn/                 types.ts, quality.ts (Messung), store.ts (Lernspeicher),
                         distill.ts (Ollama-Profil), notes.ts (Markdown im Vault)
  chat/                  view.ts (Oberfläche), assistant.ts (Ablauf + Aufwertung + Lernen), session.ts
  github/                client.ts (REST), sync.ts (Sichern/Wiederherstellen),
                         oauth.ts (Anmeldung per Geräte-Code),
                         connect.ts (Anmeldefenster)
  util/                  http.ts (Streaming + CORS-Ersatzweg), format.ts
  obsidian-bridge.ts     Vault-Zugriff, Zwischenspeicher, Embeddings, Lern-Dateien
tests/                   165 Tests in 9 Dateien inkl. Ende-zu-Ende-Tests auf main.js
                         (Werkzeuge, Internet, GitHub, HuggingFace, n8n)
```

Beitragen: bitte `npm run typecheck && npm test` grün halten.

### Ist das Release wirklich installierbar?

Bevor eine Version veröffentlicht wird, lässt sich das mit echten Anfragen an GitHub
nachprüfen — genau in der Reihenfolge, die BRAT verwendet (Release-Dateien, Version
im Manifest, Ladbarkeit des Bündels):

```bash
node install/pruefe-brat.mjs mar65vo187/jarvis                 # neueste Version
node install/pruefe-brat.mjs mar65vo187/jarvis obsidian-jarvis-2.1.2 --streng
```

Das Skript prüft die Release-Dateien `main.js`, `manifest.json`, `styles.css`, den
Versionsabgleich zwischen Tag und Manifest, lädt das veröffentlichte `main.js` **wirklich
in Node mit einer obsidian-Attrappe** (beweist, dass es ausführbar ist und eine
Plugin-Klasse mit `onload`/`onunload` exportiert), vergleicht es per SHA-256 mit dem hier
gebauten Bündel und sucht nach den Merkmalen der Lernfunktionen. Der Release-Workflow
führt diese Prüfung nach jedem Tag selbst aus.
