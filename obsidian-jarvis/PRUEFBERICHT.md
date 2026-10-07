# Prüfbericht — Jarvis AI für Obsidian 2.1.2

Stand: 7. Oktober 2026 · alle Angaben beziehen sich auf den ausgelieferten Stand
(`main.js` aus diesem Ordner). Der Bericht beschreibt, **was geprüft ist** und
**was nicht** — ohne Beschönigung.

## Kurzfassung

**165 Tests in 9 Dateien, alle grün** (`npm test`; baut vorher automatisch das Bündel).
Geprüft wurde gegen echte HTTP-Server auf `127.0.0.1` (kein Attrappen-Netzwerk), mit
echten Git-Objekt-Hashes, einem echten MCP-Kindprozess, echtem DOM und Ende-zu-Ende-Tests
auf der ausgelieferten Datei `main.js` — inklusive Werkzeugeinsatz, Internetsuche,
GitHub, HuggingFace und n8n. TypeScript läuft im `strict`-Modus fehlerfrei.

Gefundene und **behobene** Fehler während der Entwicklung: 8 aus 2.0 plus 10 aus 2.1
(siehe unten).

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
- **Gemini**: Modellliste ohne Embedding-Modelle, Stream, `systemInstruction`,
  `generationConfig.maxOutputTokens`.
- **Denk-Stufen**: `reasoning_effort` geht nur mit ausdrücklicher Einstellung in den
  OpenAI-Rumpf, `thinking` zu Claude, `generationConfig` zu Gemini; eine negative
  Temperatur („nichts senden") wird nie mitgeschickt.
- **HuggingFace-Router**: Modelle über `/v1/models`, Antworten über
  `/v1/chat/completions` mit Bearer-Schlüssel.
- **n8n**: Antworten kommen vom eigenen Webhook (`x-jarvis-key`, freier Rumpf).
- **Streaming abschaltbar**: identischer Text, aber am Stück geliefert.

## 4. Modellwahl (`tests/brain.test.ts`, 21 Tests)

Auto antwortet lokal; lokaler Fehler oder unbrauchbare Antwort → Cloud; schwere Aufgaben
direkt Cloud; lokaler Modus bleibt lokal; Cloud-Modus nutzt nie lokal; klare Meldung ohne
Einrichtung; Auswahl des stärksten installierten lokalen Modells; Presets enthalten
`claude-opus-5-5`, `gpt-6-astra`, `gemini-3.8-flash`, `qwen3.6:27b` sowie HuggingFace-,
n8n- und `gpt-oss:120b`-Vorschläge.

**Maximum und Orakel**: Maximum nimmt immer die Cloud (der lokale Dienst wird nicht
einmal gefragt); Orakel lässt ein zweites Modell auf einem anderen Anbieter die Antwort
prüfen und liefert dessen überarbeitete Endfassung; hat das zweite Modell „KEINE
EINWÄNDE", bleibt die erste Antwort; ist nur ein Anbieter eingerichtet, läuft Orakel
nicht ins Leere, sondern antwortet normal. Über den Assistenten geprüft: Im Orakel-Modus
wird die **fertige** Antwort geprüft (auch nach einem Werkzeuglauf), das Häkchen
`deliberated` wird gesetzt und der Nutzer sieht den Hinweis „Orakel: Andere Modelle
prüfen die Antwort …".

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

## 8. Werkzeuge (`tests/tools.test.ts`, 52 Tests)

- **Protokoll**: Werkzeugliste für das Modell, Erkennung von Werkzeugblöcken (auch mit
  `json`-Zaun und als `arguments`-Text), Kaputtes wird gemeldet statt still verschluckt,
  Ergebnisblöcke enthalten die echten Daten.
- **Rechner**: Punkt vor Strich, Klammern, `%`, `^`, Division durch null → Fehler,
  deutsche Zahlen (`1.000,50` → 1000,50), Unsinn wird abgewiesen.
- **Sperren**: `rm -rf /`, `shutdown`, `format`, Pipe auf Shell und Ähnliches werden mit
  Begründung abgelehnt; nur mit ausdrücklicher Freigabe läuft überhaupt ein Befehl.
- **Internet**: echte Suchdienste (Tavily-POST mit Schlüssel, Brave-Header, SearXNG,
  DuckDuckGo-HTML-Auswertung inkl. Umleitung `//duckduckgo.com/l/?uddg=`), Seiten lesen
  mit HTML→Text (Überschriften, Tabellen, Zeichen-Entitäten), Kürzung mit Hinweis,
  `file://` wird abgewiesen, fehlender Schlüssel wird erklärt.
- **Vault**: Suchen, Lesen mit Pfadvorschlägen, Schreiben nur mit Freigabe, Pfade können
  den Vault nicht verlassen.
- **GitHub**: Datei lesen (Base64 → UTF-8), Baum, Codesuche, Aufgaben (Pull-Requests
  werden übersprungen), Schreiben **nur** mit Freigabe (SHA-Abfrage, Commit-Nachricht,
  Branch, Inhalt wirklich base64-kodiert).
- **HuggingFace**: Modell-/Datensatzsuche mit Downloads und Likes, Einzelheiten inkl.
  Lizenz, Sprachen und Dateiliste.
- **n8n**: Webhook wird wirklich aufgerufen, `x-jarvis-key` mitgeschickt, JSON-Rumpf
  korrekt, Antwort kommt als Werkzeugergebnis zurück.
- **MCP**: HTTP- und stdio-Transport (**echter Kindprozess**), Werkzeugliste,
  Namensgebung `mcp_<server>_<werkzeug>`, Statusmeldung bei Nichterreichbarkeit,
  Abbruch beim Schließen.
- **Obsidian-Oberfläche**: geöffnete Notiz samt markiertem Text (und die klare Meldung, wenn
  keine offen ist), Verweise und Backlinks, Tags nach Häufigkeit gefiltert, Öffnen von
  Notizen, Tagesnotiz lesen und ergänzen, Auswahl im Editor ersetzen — Schreibendes nur mit
  Freigabe; Pfade werden bereinigt (kein Weg aus dem Vault, `.obsidian` bleibt gesperrt —
  auch beim Tagesnotizen-Ordner).
- **Agentenschleife**: Werkzeugaufruf → Ergebnis → Endantwort; Werkzeugergebnisse sind in
  Folge-Runden sichtbar; erfundene Werkzeugnamen lösen eine Korrekturrunde aus;
  `maxSteps` stoppt mit Hinweis; Token werden über alle Runden addiert; Streaming wird
  gestoppt, sobald ein Werkzeugblock beginnt.

## 9. Ausgeliefertes Bündel (`tests/bundle-smoke.test.ts`, 9 Tests)

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
- **Werkzeuge im Bündel**: Frage → Modell antwortet mit Werkzeugblock → das Plugin führt
  `web_search` wirklich aus (die Suchanfrage kommt mit Schlüssel beim Dienst an) → die
  Antwort entsteht aus dem Werkzeugergebnis, die Schritte stehen in der Anzeige.
- **Seite lesen im Bündel**: `web_read` lädt eine echte Seite, der gelesene Text steht
  nachweislich im Werkzeugergebnis-Block an das Modell (nicht nur eine Zusammenfassung).
- **Obsidian-Oberfläche im Bündel**: Über die echte Plugin-Verdrahtung liest `note_current`
  die geöffnete Notiz (der Inhalt steht nachweislich im Werkzeugergebnis an das Modell) und
  `daily_append` schreibt wirklich in die Tagesnotiz — der Pfad wird aus dem eingestellten
  Ordner und dem heutigen Datum gebildet.
- **Dienste im Bündel**: Über die echte Verdrahtung des Plugins werden `github_file`,
  `hf_search` und `n8n_run` benutzt — die Anfragen kommen wirklich beim Dienst an,
  `github_write` ist ohne Freigabe **nicht** dabei.
- Nicht erreichbarer Dienst → verständliche Fehlermeldung.

## 10. Während der Entwicklung gefundene und behobene Fehler

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

In Version 2.1 zusätzlich gefunden und behoben:

10. **Werkzeugergebnisse waren in Folge-Runden unsichtbar**: Der Verlauf wurde pro Runde
    neu aufgebaut, dadurch „vergaß" das Modell, was das Werkzeug geliefert hatte. Jetzt
    wächst der Verlauf fortlaufend.
11. **Erfundene Werkzeugnamen** wurden still ignoriert (das Modell drehte sich im Kreis).
    Jetzt folgt eine Korrekturrunde mit der Liste der erlaubten Werkzeuge.
12. **`calculate` scheiterte an deutschen Zahlen** (`1.000,50` → „Fehler ab Stelle 5").
13. **Negative Temperatur** („nichts senden") wäre an Cloud-Dienste geschickt worden und
    hätte dort zu Fehlern geführt — wird jetzt ausgelassen.
14. **Orakel prüfte die eigene Antwort** statt ein zweites Modell, und zwar in jeder
    Werkzeugrunde. Jetzt prüfen nur **andere** Modelle, und zwar die fertige Antwort
    einmal am Ende.
15. **Werkzeuge mit Cloud-Anbietern**: Bei `reasoning_effort`/`thinking` lehnten manche
    Dienste die Anfrage ab — Jarvis wiederholt sie automatisch ohne diese Felder.
16. **Automatische Anbieterreihenfolge** kannte HuggingFace und n8n nicht.
17. **GitHub-Codesuche** war fest auf api.github.com verdrahtet (nicht für GitHub
    Enterprise und nicht testbar) — nutzt jetzt die eingestellte Adresse.
18. **Werkzeugliste im Selbsttest** prüft jetzt auch GitHub, HuggingFace und n8n mit
    echten Aufrufen; `pluginVersion` im Werkzeug-Kontext war fest auf „3.0.0" gesetzt.
19. **Der Obsidian-Nachbau in den Tests bestand aus Attrappen** (`Setting.setName` warf den
    Namen weg, der Editor hatte keine `lastLine`) — dadurch hätten Fehler auf der
    Einstellungsseite und in den Oberflächen-Werkzeugen unbemerkt bleiben können. Der
    Nachbau ist jetzt näher am Original und prüft genau diese Wege.

## 11. Nachprüfung des echten Releases (`install/pruefe-brat.mjs`)

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

## 12. Was hier nicht geprüft werden konnte

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
- **Werkzeuge gegen die echten Dienste**: GitHub, Tavily/Brave/SearXNG, HuggingFace und
  n8n wurden gegen nachgebaute Server geprüft (gleiche Adressen, gleiche Formate), nicht
  mit echten Schlüsseln. Der eingebaute Selbsttest prüft sie in deinem Obsidian wirklich.
- **Befehle und Dateien außerhalb des Vaults** laufen nur unter Desktop-Obsidian; hier
  wurde der Sperrfilter und die Freigabe geprüft, nicht die Ausführung unter Windows.
- **Aussehen** in echten Obsidian-Themes (nutzt nur Obsidian-CSS-Variablen).
- **Preistabelle** ist eine Momentaufnahme (Oktober 2026), Schätzung ohne Gewähr.

## 13. Empfohlener erster echter Test bei dir

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
7. **Werkzeuge**: Einstellungen → Jarvis KI → Werkzeuge → **Werkzeuge testen**. Danach
   im Chat oben den Modus ⚡ **Maximum** wählen und fragen: „Recherchiere im Internet, wie
   man in Obsidian Vorlagen benutzt, und lege mir daraus eine Notiz an." Erwartung: du
   siehst die Werkzeugschritte („🛠️ n Werkzeug(e): web_search, vault_write …"), die
   Notiz liegt danach im Vault, und die Antwort nennt die Quelle.
8. **Orakel**: Modus 🔮 **Orakel** wählen und dieselbe Frage stellen. Erwartung: kurze
   Wartezeit, dann „🔮 von mehreren Modellen geprüft" in der Metazeile — vorausgesetzt,
   es sind mindestens zwei Cloud-Anbieter aktiv.
9. **GitHub-Werkzeug**: Mit eingerichteter GitHub-Anbindung fragen: „Zeig mir die offenen
   Aufgaben in unserem Repository." Erwartung: eine echte Liste (oder eine klare,
   verständliche Fehlermeldung, wenn der Schlüssel das nicht darf).
10. **Obsidian-Werkzeug**: Eine Notiz öffnen, einen Satz markieren und fragen: „Was steht in
    meiner geöffneten Notiz?" Erwartung: Jarvis nennt Pfad und Inhalt. Mit eingestelltem
    Tagesnotizen-Ordner: „Häng an meine Tagesnotiz an: …" — der Eintrag landet wirklich dort.
