# Prüfbericht — Jarvis AI für Obsidian 1.0.0

Stand: 7. Oktober 2026 · alle Angaben beziehen sich auf den ausgelieferten Stand
(`main.js` aus diesem Ordner).

## Was automatisiert geprüft wurde

**62 Tests, 6 Testdateien, alle grün** (`npm test`). Geprüft wurde gegen echte
HTTP-Server auf `127.0.0.1`, nicht gegen Attrappen im Arbeitsspeicher — die
Netzwerk-, Streaming- und Fehlerpfade laufen also wirklich durch.

### Anbieter (`tests/providers.test.ts`, 11 Tests)

- **Ollama**: NDJSON-Stream wird Zeile für Zeile gelesen, Text und Tokenzahlen
  (prompt_eval_count/eval_count) stimmen, `num_ctx`, `keep_alive` und Systemrolle
  werden korrekt gesendet; Antwort ohne Streaming (einzelnes JSON) wird verarbeitet;
  reine Denk-Ausgaben führen zu einer verständlichen Fehlermeldung statt zu leerem Text;
  Modellliste, Embedding-Modell-Suche, Embeddings und Entladen funktionieren.
- **OpenAI-kompatibel**: SSE-Streaming, `stream_options.include_usage`, Nutzung von
  `max_completion_tokens` (nicht `max_tokens`) bei OpenAI, Verarbeitung einer
  kompletten JSON-Antwort, korrekte Fehlerübersetzung (401 → „Zugang abgelehnt … API-Schlüssel prüfen"),
  fehlender Schlüssel wird gemeldet.
- **Claude**: Nachrichten-Stream mit `message_start` / `content_block_delta` /
  `message_delta`, Denk-Bausteine (`thinking_delta`) werden ignoriert, Tokenzahlen
  beider Richtungen stimmen, `max_tokens` wird immer gesendet, `anthropic-version`
  und `anthropic-dangerous-direct-browser-access` sind gesetzt, Fehlerereignisse im
  Stream werden erkannt.
- **Gemini**: Modellliste filtert Embedding-Modelle heraus, Stream wird gelesen,
  `systemInstruction` und `generationConfig` werden korrekt aufgebaut.
- **Streaming abschaltbar**: Mit `allowStream: false` kommt die Antwort am Stück,
  wird aber inhaltlich identisch ausgeliefert (Schalter „Streaming" in den Einstellungen).

### Modellwahl und Ausweichen (`tests/brain.test.ts`, 15 Tests)

- Auto-Modus antwortet lokal, wenn lokal funktioniert.
- Lokaler Fehler (HTTP 500) → automatisch Cloud, Ausweichkette wird protokolliert.
- Schwere Aufgabe (Analyseauftrag / sehr viel Kontext / sehr lange Frage) → direkt Cloud.
- Unbrauchbare lokale Antwort („Als KI-Modell kann ich …") → Ausweichen auf Cloud.
- Lokaler Modus bleibt lokal, auch wenn es schiefgeht; Cloud-Modus nutzt nie lokal.
- Aussagekräftige Fehlermeldung, wenn gar nichts eingerichtet ist.
- Auswahl des stärksten installierten lokalen Modells (Embedding-Modelle werden ausgenommen).
- Ablauf Frage → Quellen → Antwort: Quellen landen mit `[Q1]` im Prompt, die geöffnete
  Notiz wird auf Wunsch beigelegt, fehlende Treffer werden offen gemeldet, der
  Zwei-Durchgang-Modus („gründlich") wird gesetzt, die Wissenssuche-Einstellung greift.

### Wissensindex (`tests/vault-index.test.ts`, 12 Tests)

- Nur erlaubte Markdown-Notizen werden gelesen: ausgeschlossene Ordner, versteckte
  Ordner (`.obsidian`), Nicht-Markdown und Notizen mit `ki-privat: true` fallen raus.
- Abschnittsbildung an Überschriften, Stoppwortfilter, Umlaut-Normalisierung.
- Treffer über Stichworte; Treffer über Vektoren, wenn kein Wort übereinstimmt
  (deterministischer Test-Embedder).
- Geänderte und gelöschte Notizen werden beim nächsten Lauf nachgezogen.
- **Zwischenspeicher übersteht einen Neustart** — dabei wurde ein echter Fehler gefunden
  (nach dem Neuladen waren die Stichwortlisten leer); behoben und abgesichert.
- Kontextbudget und Vielfalt (höchstens 2 Abschnitte pro Notiz) werden eingehalten.
- Prompt-Regeln gegen Erfindungen, Quellenkennzeichnung, Verhalten ohne Treffer.

### GitHub (`tests/github.test.ts`, 10 Tests)

Gegen einen nachgebauten, aber echten GitHub-Git-Data-Server (HTTP, echte Git-Objekt-Hashes):

- Git-Blob-Hash stimmt mit Gits eigener Berechnung überein (`hello world\n`,
  leerer Inhalt, und die reine JavaScript-SHA-1 gegen Node für 6 Längen).
- Erste Sicherung legt Branch, Blobs, Baum und Commit an.
- Zweite Sicherung überträgt **nichts** („Nichts zu sichern"), nach Änderung genau
  eine Datei — der Vergleich läuft über Hashes, nicht über Zeitstempel.
- Gelöschte Dateien werden nur mit aktivierter Einstellung entfernt.
- Unterordner (`pathPrefix`) und „nur Markdown" funktionieren.
- Fehlende Angaben (Owner/Repo) führen zu klarer Meldung.
- Wiederherstellung: neue Dateien werden geladen, identische Dateien übersprungen,
  Änderungen des Quellrechners kommen korrekt an (Version 1 → Version 2 plus neue Datei).

### Oberfläche (`tests/ui.test.ts`, 11 Tests)

Gegen die nachgebaute Obsidian-Schnittstelle mit echtem DOM:

- Werkzeugleiste, Statuszeile und Modellliste (mit lokalen und Cloud-Modellen) werden aufgebaut;
  die Modellwahl schaltet den Betriebsmodus passend mit.
- Senden → Streaming-Text erscheint, Quellenchips werden angezeigt, Metazeile zeigt
  Modell, Dauer, Tokenzahlen und Kosten.
- Fehlerfall zeigt Hilfestellung („ollama serve") und den Knopf „Mit Cloud-Modell erneut versuchen".
- Abbruch-Signal erreicht das Modell; Ausweichkette und Nicht-Streaming-Hinweis erscheinen.
- Verlauf: Titel aus der ersten Frage, Sitzungswechsel, Löschen, Begrenzung auf 40 Beiträge.
- Beim Schließen der Ansicht wird eine laufende Anfrage abgebrochen.

### Fertiges Bündel (`tests/bundle-smoke.test.ts`, 3 Tests)

Geladen wird hier nicht der Quellcode, sondern die ausgelieferte Datei `main.js` —
in einer nachgebauten Obsidian-Umgebung und gegen einen echten lokalen Ollama-Server:

- Das Bündel lädt, exportiert die Plugin-Klasse und richtet sich vollständig ein.
- Modelle werden wirklich vom Dienst geholt (`/api/tags`), der Wissensindex wird über
  den echten Vault-Zugriff aufgebaut.
- Eine komplette Frage läuft durch alle Schichten (Index → Suche → Prompt → Ollama →
  Antwort) und kommt mit korrekter Quellenangabe `[Q1] Projekt Alpha.md` zurück;
  der tatsächlich gesendete Prompt enthält die Notiz und die Quellen-Regeln.
- Der Diagnosebericht enthält alle Abschnitte (Ollama, Cloud, GitHub, Wissen, Einstellungen).
- Nicht erreichbarer Dienst → verständliche Fehlermeldung „Kein Modell konnte antworten".

## Was zusätzlich statisch geprüft wurde

- `npm run typecheck` (TypeScript, `strict`) läuft fehlerfrei über `src/` und `tests/`.
- `npm run build` erzeugt ein Bündel von rund 106 KB (esbuild, CJS, Ziel Obsidian).
- `npm test` baut das Bündel vorher automatisch, damit die Tests nie auf einem alten Stand laufen.
- Es werden **keine** externen Laufzeit-Abhängigkeiten mitgeliefert; das Bündel nutzt
  nur Obsidian-Schnittstellen und Browser-Standards (`fetch`, `crypto`, `btoa/atob`).
- CORS-Ersatzweg: Wenn ein Dienst direkte Browser-Anfragen blockt (typisch: Ollama ohne
  `OLLAMA_ORIGINS` oder die OpenAI-API), schaltet das Plugin automatisch auf Obsidians
  `requestUrl` um und zeigt die Antwort ohne Streaming. Beide Wege sind getestet.
- `crypto.subtle` fehlt auf manchen Mobilgeräten; deshalb gibt es eine eigene
  SHA-1-Umsetzung, die gegen Node geprüft ist (siehe oben).

## Was hier nicht geprüft werden konnte

- **Kein echter Modelllauf**: In dieser Umgebung lief kein Ollama-Dienst und es wurden
  keine Cloud-Schlüssel verwendet. Die Qualität einer Antwort hängt am gewählten Modell
  und wurde nicht bewertet.
- **Kein echter GitHub-Zugriff**: Der Sync wurde gegen einen nachgebauten Server
  getestet (echte Hashes, echte HTTP-Aufrufe). Die Rechteprüfung deines Tokens kann
  erst bei dir stattfinden — dafür gibt es „Verbindung testen".
- **Windows-Installer**: Das PowerShell-Skript wurde nicht unter Windows ausgeführt.
  Es kopiert drei Dateien, sichert alte Stände und liest die Vault-Liste aus
  `obsidian.json`; alle Befehle sind einzeln nachvollziehbar. Wenn es bei dir scheitert,
  nimm Weg C (drei Dateien von Hand kopieren) aus der README — das ist gleichwertig.
- **Oberflächen-Layout in echtem Obsidian**: Das Aussehen nutzt Obsidian-CSS-Variablen
  und wurde nur in der Testumgebung aufgebaut, nicht auf echten Themes geprüft.
- **Kostenangaben**: Die Preistabelle ist eine Momentaufnahme (Oktober 2026) und eine
  Schätzung ohne Gewähr.

## Erster echter Test bei dir

1. Einstellungen → Jarvis KI → **Alle Verbindungen prüfen**. Der Bericht zeigt, was
   erreichbar ist, welche Modelle gefunden wurden und ob ein Embedding-Modell läuft.
2. Eine Frage stellen, deren Antwort du kennst (z. B. „Was steht in Notiz X?"), und
   die Quellen unter der Antwort anklicken.
3. Erst danach produktiv nutzen.
