# Technische Quellen

Offizielle Quellen, abgerufen am 07.10.2026:

- [Ollama API: Chat](https://docs.ollama.com/api/chat) – Nachrichten und Streaming.
- [Ollama API: Modelle](https://docs.ollama.com/api/tags) – installierte Modelle.
- [Ollama API-Typen](https://github.com/ollama/ollama/blob/main/api/types.go) – lokale und entfernte Modellmetadaten.
- [Ollama Cloud](https://docs.ollama.com/cloud) – Anmeldung und Cloud-Modellnamen.
- [Ollama Preise](https://ollama.com/pricing) – begrenztes Gratis-Kontingent und kostenpflichtige Nutzung.
- [Ollama Modelfile](https://docs.ollama.com/modelfile) – lokale Modellprofile.
- [Ollama FAQ](https://docs.ollama.com/faq) – lokaler Betrieb, Cloud abschalten, Kontext und Speicher.
- [Qwen3 1.7b](https://ollama.com/library/qwen3:1.7b) – kleiner Einstieg, Dateigröße ca. 1,4 GB.
- [Qwen3 4b-instruct](https://ollama.com/library/qwen3:4b-instruct) – Alternative, Dateigröße ca. 2,5 GB.
- [Obsidian Plugins](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin) – Pluginordner und Aktivierung.
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault) – Notizen lesen und erstellen.
- [Obsidian Manifest](https://docs.obsidian.md/Reference/Manifest) – Desktop-Pluginformat.
- [Hugging Face Spaces](https://huggingface.co/docs/hub/en/spaces-overview) – aktuelle Einschränkungen kostenloser Serverangebote.

Die Erweiterung ist auf ein vorhandenes Obsidian-System zugeschnitten und verwendet dessen API direkt. Es sind keine zusätzlichen Laufzeitpakete, Serverframeworks eingebaut. Die optionale Cloud-Anbindung unterliegt dem jeweils angemeldeten Ollama-Tarif. Modelllizenzen gelten unabhängig vom Plugin; die Modelle werden über Ollama bezogen.
