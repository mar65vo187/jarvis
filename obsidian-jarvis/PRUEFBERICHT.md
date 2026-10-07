# Prüfbericht — Jarvis AI für Obsidian 2.0.1

Stand: 7. Oktober 2026 · alle Angaben beziehen sich auf den ausgelieferten Stand
(`main.js` aus diesem Ordner). Der Bericht beschreibt, **was geprüft ist** und
**was nicht** — ohne Beschönigung.

## Kurzfassung

**96 Tests in 8 Dateien, alle grün** (`npm test`; baut vorher automatisch das Bündel).
Geprüft wurde gegen echte HTTP-Server auf `127.0.0.1` (kein Attrappen-Netzwerk), mit
echten Git-Objekt-Hashes, echtem DOM und einem Ende-zu-Ende-Test auf der ausgelieferten
Datei `main.js`. TypeScript läuft im `strict`-Modus fehlerfrei.

Gefundene und **behobene** Fehler während der Entwicklung: 8 (siehe unten).

---

## 1. Verbesserungskreislauf (`tests/learning-loop.test.ts`, 10 Tests)

Das ist der Kern von Version 2.0. Der Testserver verhält sich wie ein echtes Modell:
Er antwortet schlecht, solange ihm die Information fehlt, und gut, sobald sie ihm als
gelerntes Wissen mitgeliefert wird.

- **Schwache lokale Antwort wird erkannt und ersetzt**: Abdeckung der lokalen Antwort
  unter 40 %, Cloud-Abdeckung über 70 %, `escalated = true`, Eintrag in den Hinweisen
  („Lokale Antwort war zu schwach → von openai/gpt-6-astra aufgearbeitet").
- **Daraus wird gelernt**: Lektion gespeichert (Grund „upgrade", Herkunftsmodell,
  Notizquelle), Markdown-Notiz im Vault mit `jarvis-gelernt: true`, Gedächtnisordner
  automatisch aus der Vault-Suche ausgenommen.
- **Nächste gleiche Frage**: das lokale Modell antwortet **ohne Cloud** (Netzwerkzähler
  bleibt bei 1 Aufruf), Abdeckung über 60 %, die Lektion steht nachweislich als
  `GELERNTES WISSEN` und `[W1]` im Prompt, sowohl im letzten Nutzerbeitrag als auch in
  der Systemanweisung.
- **Messbarer Fortschritt**: Der Qualitätsverlauf enthält zwei Werte — Runde 1
  (lokal schwach, Cloud stark), Runde 2 (lokal stark); die Differenz ist größer als
  30 Prozentpunkte. Die Lektion wurde als benutzt vermerkt (`usedCount > 0`).
- **„Nachfragen"-Modus**: Es wird nichts gespeichert; erst der Klick auf „Merken"
  speichert die Lektion.
- **Lernumfang**: `nur Ausweichfälle` lernt nicht, wenn keine Ausweichung nötig war;
  `aus jeder Cloud-Antwort` lernt auch im Cloud-Modus.
- **Fehlerhafte Cloud-Antwort** (HTTP 429) führt zu einer Fehlermeldung und **nicht**
  zu einer Lektion.
- **Nutzerkorrektur** wird verbindlich: Korrektur steht in der Notiz im Vault, in den
  Regeln der Einstellungen und im Modelfile (`Korrigierte Fassung (verbindlich)`).
- **Prompt-Aufbau**: Notizwissen (`[Q1]`) und gelerntes Wissen (`[W1]`) kommen
  gemeinsam und getrennt gekennzeichnet an.
- **Abgeschaltetes Lernen** ändert nichts am bisherigen Verhalten (keine Lektion, kein
  `GELERNTES WISSEN` im Prompt).

## 2. Lern-Bausteine (`tests/learning.test.ts`, 21 Tests)

**Qualitätsmessung**
- Schlüsselbegriffe werden aus den Quellen gezogen — Eigennamen und Zahlen zuerst,
  Stoppwörter entfernt, maximal 24 Begriffe, deutsche Wortformen über Wortstamm erkannt.
- Schwache Antwort („Ich habe dazu eine Notiz gefunden") → Abdeckung unter 30 %,
  als schwach erkannt; vollständige Antwort → Abdeckung über 60 %, nicht schwach.
- Ausweich-Floskeln („Als KI-Modell kann ich …") werden erkannt; ehrliche Hinweise
  („in den Quellen findet sich dazu nichts") **nicht** fälschlich als Ausweichantwort.
- Vergleich lokal gegen Cloud nennt Abdeckungen und die Verbesserung.

**Lernspeicher**
- Lektionen werden gespeichert, wiedergefunden (Frage „Wann ist der Endtermin von
  Projekt Alpha?" findet „Wann endet Projekt Alpha?") und Dubletten zusammengeführt.
- **Neustart-Festigkeit**: Nach neuem Laden aus derselben Datei sind Lektionen,
  Modellstatistik und Qualitätsverlauf identisch vorhanden.
- **Beschädigte Datei** (`{kaputt`) führt nicht zum Absturz — Speicher startet leer und
  speichert anschließend korrekt weiter.
- Bewerten (`good`/`bad`), Korrigieren (Korrektur wird bevorzugt gefunden und mit
  „Vom Nutzer korrigiert" gerendert).
- Obergrenze wird eingehalten; als schlecht bewertete Einträge fallen zuerst heraus.
- Verlaufstext enthält Zeitstempel, Art (Antwort/Aufwertung/destilliert) und
  Prozentwerte für lokal und Cloud.
- Zähler für „neue Lektionen seit dem letzten Verbessern" funktioniert (2 → nach
  Destillation 0).

**Destillation**
- Modelfile enthält `FROM`, `PARAMETER temperature`, `PARAMETER num_ctx`, `SYSTEM`,
  Regeln aus Korrekturen und `MESSAGE user` / `MESSAGE assistant` je Beispiel.
- Dreifache Anführungszeichen im Inhalt können das Modelfile nicht zerstören
  (`escapeTripleQuote`, geprüft: kein `""""""` im Ergebnis).
- Plan wählt die besten Beispiele (gute Bewertung, Korrektur, Nutzung, Aufwertung),
  überspringt zu kurze Antworten und meldet, was ausgelassen wurde.
- Ablehnung mit klarer Begründung, wenn noch nichts gelernt wurde oder keine geeigneten
  Beispiele existieren.
- `run()` legt das Profil über die Ollama-API an und **prüft anschließend, ob Ollama es
  wirklich führt** — sonst klare Fehlermeldung statt stiller Lüge.
- Aufräumen alter Profile: `jarvis-brain-v2` wird entfernt, `jarvis-brain-v1` und das
  Basismodell `qwen3:8b` bleiben unangetastet.

**Gelerntes als Markdown**
- Notiz enthält Kopfbereich (`jarvis-gelernt`, `jarvis-id`, Modell, Grund, Bewertung),
  Frage, gelernte Antwort, Korrektur (falls vorhanden) und Quellenverweise `[[…]]`.
- Nur fehlende Notizen werden angelegt (zweiter Lauf: 0 neu, 2 vorhanden).
- Mit `writeNotes: false` wird nichts geschrieben.
- **Wiederherstellung**: Eine Notiz wird wieder vollständig als Lektion eingelesen
  (Frage, Antwort, Modell, Grund, Bewertung, Korrektur, Quellen) — mit ihrer
  ursprünglichen Kennung, sodass keine Dubletten entstehen. Änderungen von Hand werden
  übernommen. Eine von Hand gekürzte Notiz (nur Überschrift + Text) wird ebenfalls
  eingelesen, und eine Notiz ohne das Merkmal `jarvis-gelernt: true` bleibt unberührt.
  Ohne `jarvis-id` ist die vergebene Kennung über mehrere Läufe stabil.

## 3. Anbieter (`tests/providers.test.ts`, 11 Tests)

- **Ollama**: NDJSON-Stream Zeile für Zeile, Tokenzahlen, `num_ctx`, `keep_alive`,
  Systemrolle; Antwort ohne Streaming; reine Denk-Ausgaben → verständlicher Fehler;
  Modellliste, Embedding-Suche, Embeddings, Entladen.
- **OpenAI-kompatibel**: SSE, `stream_options.include_usage`,
  `max_completion_tokens` statt `max_tokens` bei OpenAI, komplette JSON-Antwort,
  Fehlerübersetzung (401 → „Zugang abgelehnt … API-Schlüssel prüfen"), fehlender Schlüssel.
- **Claude**: Stream-Ereignisse, Denk-Bausteine werden ignoriert, Tokenzahlen in beide
  Richtungen, `anthropic-version`, `anthropic-dangerous-direct-browser-access`,
  Fehlerereignisse.
- **Gemini**: Modellliste ohne Embedding-Modelle, Stream, `systemInstruction`.
- **Streaming abschaltbar**: identischer Text, aber am Stück geliefert.

## 4. Modellwahl (`tests/brain.test.ts`, 15 Tests)

Auto antwortet lokal; lokaler Fehler oder unbrauchbare Antwort → Cloud; schwere Aufgaben
direkt Cloud; lokaler Modus bleibt lokal; Cloud-Modus nutzt nie lokal; klare Meldung ohne
Einrichtung; Auswahl des stärksten installierten lokalen Modells; Presets enthalten
`claude-opus-5-5`, `gpt-6-astra`, `gemini-3.8-flash`, `qwen3.6:27b`.

## 5. Wissensindex (`tests/vault-index.test.ts`, 12 Tests)

Ausschlüsse (Ordner, versteckte Ordner, Nicht-Markdown, `ki-privat`), Abschnittsbildung,
Abdeckung von Stichwort- **und** Vektorsuche, Nachziehen geänderter/gelöschter Notizen,
Neustart über den Zwischenspeicher, Kontextbudget und Vielfalt (max. 2 Abschnitte je
Notiz), Prompt-Regeln gegen Erfindungen.

## 6. GitHub (`tests/github.test.ts`, 10 Tests)

Gegen einen nachgebauten Git-Data-Server mit echten Hashes: SHA-1-Übereinstimmung mit
Git (inkl. reiner JavaScript-Umsetzung für Mobilgeräte), erste Sicherung, zweite
Sicherung ohne Übertragung, Änderungserkennung, Löschen nur auf Wunsch, Unterordner,
„nur Markdown", Wiederherstellung (neu, geändert, unverändert), klare Fehlermeldungen.

## 7. Oberfläche (`tests/ui.test.ts`, 12 Tests)

Aufbau der Bedienelemente, Modellwahl schaltet den Modus mit, Standardwert der
Notiz-Option, Streaming-Antwort mit Quellenchips und Metazeile (Modell, Dauer, Token,
Qualität), Fehlerfall mit Hilfestellung und Cloud-Retry, Abbruch, Ausweichhinweis,
Quellenklick, Aufräumen beim Schließen, Verlaufsverwaltung (Titel, Wechsel, Löschen,
Begrenzung auf 40 Beiträge).

## 8. Ausgeliefertes Bündel (`tests/bundle-smoke.test.ts`, 5 Tests)

Geladen wird die echte `main.js` in einer nachgebauten Obsidian-Umgebung, mit echtem
Ollama-Testserver:

- Bündel lädt, exportiert die Plugin-Klasse, richtet sich vollständig ein; Modelle
  kommen wirklich vom Dienst; Index wird über den echten Vault-Zugriff aufgebaut.
- Komplette Frage durch alle Schichten mit korrekter Quellenangabe `[Q1] Projekt Alpha.md`;
  der gesendete Prompt enthält die Notizen und die Quellenregeln.
- **Lernen im Bündel**: Cloud-Antwort → Lektion gespeichert, Markdown-Notiz im Vault,
  Gedächtnisordner ausgeschlossen; zweite Frage schickt `GELERNTES WISSEN` ans lokale
  Modell; Destillation legt über die echte Ollama-Schnittstelle `/api/create` das Profil
  `jarvis-brain-v1` an (Modelfile mit `FROM qwen3:8b`, `SYSTEM`, `MESSAGE`), der
  Lernbericht enthält Lektionen und Qualitätsverlauf.
- **Neuinstallation im Test**: Zwischenspeicher `cache/learning.json` gelöscht, Notizen
  bleiben im Vault → das frische Plugin startet mit 0 Lektionen, holt über
  `restoreLessonsFromNotes()` beide Lektionen aus den Markdown-Notizen zurück, verwendet
  sie sofort wieder im Prompt an das lokale Modell und erzeugt beim zweiten Lauf keine
  Dubletten.
- Nicht erreichbarer Dienst → verständliche Fehlermeldung.

## 9. Während der Entwicklung gefundene und behobene Fehler

1. **GET statt POST** im CORS-Ersatzweg (`postJson` setzte keine Methode).
2. **Suche nach Neustart kaputt**: Stichwortlisten wurden nicht mitgespeichert.
3. **`crypto.subtle` fehlt** auf manchen Mobilgeräten → eigene, gegen Node geprüfte
   SHA-1-Umsetzung (ein Auffüllfehler bei genauem Blockmaß wurde dabei gefunden).
4. **Auto-Backup-Zeitstempel** war sprachabhängig geparst → jetzt zusätzlich ISO-Wert.
5. **Ausweich-Erkennung** übersah die Schreibweise „KI-Modell" (mit Bindestrich).
6. **Irrelevante Lektionen** wurden ohne echte Wortübereinstimmung verwendet (nur wegen
   ihres Alters) → jetzt harte Mindestübereinstimmung.
7. **Speicherverzögerungen** machten Tests unnötig langsam → einstellbare Verzögerung.
8. **Wiederherstellung las Abschnitte falsch**: Ein Abschnittsmuster mit einem in
   JavaScript nicht vorhandenen Zeilenende-Kürzel (`\Z`) schnitt Quellen und Antworten
   ab. Ersetzt durch sauberes Zerlegen der Notiz in Abschnitte.
9. **Testnachbau der GitHub-Baum-Schnittstelle** schnitt den Pfad falsch ab (Testfehler,
   kein Produktfehler) — korrigiert, damit der Test wirklich prüft, was er behauptet.

## 10. Nachprüfung des echten Releases (`install/pruefe-brat.mjs`)

Die veröffentlichte Version wurde mit echten Anfragen an GitHub geprüft — in der
Reihenfolge, in der BRAT installiert (Ergebnis vom 7. Oktober 2026, Version 2.0.0):

```
✓ Release obsidian-jarvis-2.0.0 gefunden
✓ Release-Datei "main.js" vorhanden (141.4 KB)
✓ Release-Datei "manifest.json" vorhanden (0.5 KB)
✓ Release-Datei "styles.css" vorhanden (4.6 KB)
✓ manifest.json geladen: jarvis-ai 2.0.0
✓ Tag-Version obsidian-jarvis-2.0.0 passt zu manifest.json 2.0.0
✓ main.js lässt sich laden und exportiert eine Plugin-Klasse (48 Methoden)
✓ main.js enthält das Merkmal "GELERNTES WISSEN"
✓ main.js enthält das Merkmal "jarvis-brain-"
✓ Die veröffentlichte main.js ist byte-identisch mit dem hier gebauten Bündel (SHA-256)
Ergebnis: BRAT kann "mar65vo187/jarvis" installieren (Version obsidian-jarvis-2.0.0).
```

Das Bündel wurde dabei **wirklich in Node geladen** (mit einer Attrappe für das
obsidian-Paket): Es exportiert eine Klasse, die von `Plugin` erbt und `onload` sowie
`onunload` besitzt — genau das, was Obsidian beim Aktivieren tut. Zusätzlich läuft diese
Prüfung im Workflow nach jedem Tag automatisch (mit drei Versuchen, weil GitHub neue
Releases manchmal kurz verzögert ausliefert).

Auch der Installationshelfer wurde ausgeführt: `install/install.sh` kopiert in einen
frischen Vault genau `main.js`, `manifest.json` und `styles.css` (Inhalt per md5 geprüft)
und legt vor einem Update eine Sicherung der alten Dateien an.

## 11. Was hier nicht geprüft werden konnte

- **Kein echter Modelllauf**: In dieser Umgebung lief kein Ollama-Dienst und es wurden
  keine Cloud-Schlüssel verwendet. **Die Qualität echter Antworten** (und damit, wie
  schnell sich dein lokales Modell in der Praxis verbessert) ist **nicht** gemessen —
  dafür gibt es Qualitätsverlauf und Lernbericht in deinem Obsidian.
- **Keine echte Ollama-Modellerstellung**: `/api/create` wurde gegen einen echten
  HTTP-Server geprüft, aber nicht gegen einen echten Ollama-Daemon. Der erste echte Bau
  eines `jarvis-brain-vX` findet auf deinem Rechner statt; der Verbindungstest und die
  Nachprüfung, ob Ollama das Profil führt, sind eingebaut.
- **Kein echter GitHub-Zugriff** und keine Rechteprüfung deines Tokens (dafür
  „Verbindung testen").
- **Windows-Installer** (`Install-Windows.ps1`, `.cmd`) wurde nicht unter Windows
  ausgeführt — in dieser Umgebung gibt es kein PowerShell. Geprüft: der Inhalt der Dateien
  (gleiche Schritte wie `install.sh`, das ausgeführt wurde), und die Installation von Hand
  sowie über BRAT sind gleichwertige Wege ohne PowerShell.
- **Aussehen** in echten Obsidian-Themes (nutzt nur Obsidian-CSS-Variablen).
- **Preistabelle** ist eine Momentaufnahme (Oktober 2026), Schätzung ohne Gewähr.

## 12. Empfohlener erster echter Test bei dir

1. Einstellungen → Jarvis KI → **Alle Verbindungen prüfen**.
2. Eine Frage stellen, deren Antwort du kennst (Modus ⚡ Auto). Erwartung: lokale Antwort,
   Qualität in %, ggf. Aufwertung durch Cloud mit Hinweis „Lokale Antwort war zu schwach".
3. Unter der Cloud-Antwort auf **Hilfreich** klicken (oder korrigieren).
4. In der Kopfzeile prüfen: Lektionen sind gestiegen. Befehl **Lernen: Was hat Jarvis
   gelernt?** zeigt den Verlauf.
5. Dieselbe Frage erneut im Modus 🏠 Lokal: Das Gelernte steht im Prompt, die Antwort
   sollte die fehlenden Punkte jetzt enthalten.
6. Wenn einige Lektionen zusammen sind: 🎓 **Lernmodell bauen** → Standardmodell wird
   `jarvis-brain-vX` → erneut fragen und den Qualitätsverlauf vergleichen.
