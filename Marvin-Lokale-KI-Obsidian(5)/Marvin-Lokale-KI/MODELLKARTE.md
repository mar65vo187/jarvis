# Marvin Brain 2.0

Marvin Brain ist ein persönliches Ollama-Modellprofil mit einer Obsidian-Anwendung.
Es ist kein neu vortrainiertes oder feinabgestimmtes Basismodell.

| Bestandteil | Umsetzung |
|---|---|
| Lokales Hauptprofil | `marvin-brain:4b-v2`, Basis `qwen3:4b-instruct` |
| Optionales kleines Profil | `marvin-brain:lite-v2`, Basis `qwen3:1.7b` |
| Modellgewichte | Von Ollama bezogen, nicht in dieser ZIP enthalten |
| Personalisierung | Deutsche Systemanweisungen, aktuelle Notizquellen und bestätigte Korrekturen |
| Wissenssuche | Gewichtete Wörter und Titel, begrenzte Textausschnitte; keine Vektordatenbank |
| Standardkontext | 4096 Token; größere Einstellung optional |
| Lokaler Schnellmodus | `think:false`, Temperatur 0,2, begrenzte Antwortlänge |
| Gedächtnis | Letzte 20 Antworten in Plugin-Daten, Korrekturen als Markdown-Notizen |
| Online | Separates, im Ollama-Konto verfügbares Cloud-Modell; gleiche Obsidian-Wissenssuche |
| Training | Keines; keine LoRA-Adapter oder veränderten Modellgewichte |
| Betrieb | Windows, Desktop-Obsidian, laufender Ollama-Dienst |

Das 4B-Profil ist wegen des bereits heruntergeladenen Modells ein sinnvoller erster
Kandidat. Ohne Messwerte von CPU, GPU und freiem RAM ist keine Aussage über die
beste Modellwahl oder eine konkrete Antwortzeit möglich. Der Profilname und der
Systemtext machen das Basismodell nicht grundsätzlich intelligenter.

Die Qwen3-4B-Instruct-Datei wird im Ollama-Verzeichnis als Q4_K_M mit rund 2,5 GB
angegeben. Der Laufzeitspeicher ist größer und hängt unter anderem vom Kontext ab.
Bei etwa 8 GB Gesamtspeicher konkurrieren Windows, Obsidian und das Modell um RAM.
Die Wahl eines größeren Modells löst fehlenden Speicher nicht.

Im Plugin ersetzen dessen ausführlichere Systemanweisungen die Standardanweisungen
des Ollama-Profils. Das Profil ist auch außerhalb Obsidian verwendbar; dort werden
die Notizen jedoch nicht automatisch mitgeliefert.

## Grenzen

- Keine garantierte Überlegenheit gegenüber anderen Modellen und keine behauptete
  Gleichwertigkeit mit großen Frontier-Modellen.
- Korrekturen werden gesucht, nicht ins Modell trainiert. Falsche oder veraltete
  Notizen können falsche Antworten verursachen.
- Wortsuche kann Synonyme und relevante Quellen übersehen. Für wichtige Aufgaben
  konkrete Notiznamen nennen oder die geöffnete Notiz gezielt einbeziehen.
- Keine vollständige Archivübersicht, PDF-/Bildanalyse oder Internetrecherche.
- Kein Kalenderzugriff, Versand, Rechnungsversand oder Computersteuerung.
- Kein autonomes Weiterarbeiten bei geschlossenem Obsidian oder ausgeschaltetem PC.
- Cloud-Verfügbarkeit, Qualität und Gratis-Kontingent hängen vom Anbieter/Konto ab.

## Prüfung und Herkunft

Die ausgelieferte JavaScript-Anwendung wird mit einem simulierten Obsidian-Vault
und HTTP-Ollama-Dienst getestet. Echte Modellqualität, Windows-Einrichtung und
Cloud-Konto wurden hier nicht ausgeführt. Der Windows-Helfer enthält einen echten
lokalen Antworttest für deinen PC. `QUALITAETSTEST.md` ermöglicht einen eigenen
Vergleich anhand kontrollierter Fakten.

Basismodell-Lizenzen bleiben gültig und sind über `ollama show MODELL --license`
einsehbar. Quellen: https://ollama.com/library/qwen3:4b-instruct und
https://docs.ollama.com/modelfile.
