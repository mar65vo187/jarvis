# Prüfung

16 Testgruppen erfolgreich. Syntax des ausgelieferten Plugins geprüft.

## Nachweise

- Ordnergrenzen, verborgene Dateien und Dateinamen geprüft; Bild-/HTML-Einbettungen in gespeicherten Antworten entschärft.
- Im lokalen Modus werden Cloud-Verweise und reine Embedding-Modelle abgewiesen.
- Wissenssuche priorisiert passende Quellen, meldet fehlende Treffer und begrenzt den Kontext.
- Private Notizen und Vorlagen ausgeschlossen; geänderte Notizen beim nächsten Lesen aktualisiert.
- Gesamtablauf mit simuliertem Ollama: Modellwahl → Notizensuche → gestreamte Antwort mit Umlauten → neue Aufgabennotiz; vorhandene Notizen unverändert.
- Schnellmodus nutzt genau einen Aufruf ohne Thinking und hält das Modell 10 Minuten geladen.
- Chat und Bewertung nach simuliertem Plugin-Neustart wiederhergestellt; bestätigte Korrektur erneut auffindbar.
- Chat auf 20 Antworten begrenzt; Chat löschen lässt bestätigte Gedächtnisnotizen bestehen.
- Vorladen, zwei getrennte Messläufe mit korrekter Tokenrate, Diagnose und Entladen ohne Notizinhalte und ohne Chatänderung.
- Optionaler gründlicher Modus führt genau drei Aufrufe aus; Schnellmodus bleibt Standard.
- Cloud-Verweis im Modell verhindert das Senden der Wissensnotizen an die Chat-API.
- Online-Vorschau zeigt die Nutzlast; Schließen und Stoppen brechen ab, nur der Sendeknopf gibt frei.
- Online sendet genau die freigegebene Nutzlast ohne alten Chat; Kontingentfehler lösen weder Wiederholung noch Modellwechsel aus.
- Lokales Modell bleibt gespeichert; neue Ansicht startet immer lokal.
- Fehler, unvollständige Streams, Abbruch, Zeitlimit, externe Ziele und Weiterleitungen geprüft.
- Schließen der Ansicht leert nur den UI-Speicher; gespeicherter Verlauf bleibt erhalten.

## Grenzen

Kein echter Ollama-Modelllauf; keine Desktop-Obsidian-, echte Cloud- oder Windows-Prüfung. Der PowerShell-Helfer wurde hier nicht unter Windows ausgeführt; ein echter lokaler Antworttest ist im Helfer eingebaut. Der Integrationstest simuliert die offiziellen API-Antworten und die Obsidian-Vault-Schnittstelle. Der erste echte Test findet nach der Installation auf deinem PC statt.

## Installationskorrektur 2.0.1

Gezielte statische Prüfungen bestanden: sechs eindeutig benannte PowerShell-Hilfsfunktionen; alle vier nativen Ollama-Aufrufe mit benanntem Argumentarray; Rückgabecodeprüfung; Vault-Vorschlag und Abweisung des Einrichtungspaket-Ordners; bestehende data.json bleibt außerhalb der kopierten Dateien. Kein ausgeführter PowerShell-/Windows-Test.
