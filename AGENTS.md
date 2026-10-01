# Hinweise für KI-Entwickler (ChatGPT Codex, Claude & Co.)

J.A.R.V.I.S. ist Marvins persönliche KI. Oberfläche, Meldungen, Doku: **Deutsch**.
Mehrere KIs arbeiten an diesem Repo – bitte kleine, nachvollziehbare Commits mit klarer Beschreibung.

## Aufbau
- `jarvis/brain.py` – Agent-Schleife; `_call` wählt den Anbieter, erzwingt Privatsphäre (lokal) und
  wechselt bei vorübergehendem Cloud-Ausfall auf Ollama
- `jarvis/privacy.py` – Einbahnstraße: Markierung privater Daten, Ausgangsschleuse, Verschlüsselung
- `jarvis/knowledge.py` – eigener Wissensspeicher (Wissen von Lehrer-KIs, nur herein)
- `jarvis/performance.py` – Adaptive Brain: Fast/Balanced/Deep, lokale Latenzmessung und Auto-Tuning
- `jarvis/xkiro.py` / `jarvis/claude.py` – Cloud-Anbieter · `jarvis/agents.py` – Spezialistenrat (nur `smart`,
  nie mit privaten Inhalten) · `jarvis/errors.py` – `CloudUnavailable` (vorübergehend → Ersatz erlaubt),
  `CloudConfigError` (Einrichtung → kein Wechsel), `PrivacyBlocked`
- `jarvis/tools.py` – Werkzeuge (inkl. `ask_teacher`) · `jarvis/guard.py` – Freigaben, NOTAUS, Pfade ·
  `jarvis/skills.py` – eigene Skills
- `jarvis/web.py` – Dashboard-API (lokal ohne Passwort, Server-Modus nur mit Login) · `hud/index.html`
- `jarvis/telegram_bot.py` – Telegram (Kopplung per Code) · `jarvis/config.py` – `.env`, Anbieterwahl
- `windows/` – PC-Installer · `deploy/oracle/` – Online-Server (Tailscale, Backups) · `tests/` – Tests

## Pflicht vor jedem Commit
```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
bash -n deploy/oracle/install.sh deploy/oracle/update.sh deploy/oracle/backup.sh
node --check <(python -c "import re;print(re.findall(r'<script>(.*?)</script>',open('hud/index.html',encoding='utf-8').read(),re.S)[0])")
```
Alle Tests grün; neue Funktionen bekommen Tests. GitHub Actions prüft zusätzlich Windows,
PowerShell-Syntax und einen echten Browser-Durchlauf (`tests/browser.cjs`).

## Privatsphäre-Architektur (Pflicht für jede neue Funktion)
- Neue Werkzeuge, deren Ergebnis private Daten enthält → in `privacy.PRIVATE_SOURCE_TOOLS` eintragen.
- Neue Werkzeuge, die Daten nach draußen schicken → in `privacy.OUTBOUND_TOOLS` (Versand an Dritte zusätzlich
  `OUTBOUND_NEEDS_APPROVAL`).
- Jeder Weg zu einer Cloud-KI (auch Agentenrat, Remote-Workflows, Hugging-Face-Router) muss
  `privacy.must_stay_local(...)` / `privacy.sensitive_findings(...)` respektieren und einen Test in
  `tests/test_privacy.py` bekommen, der beweist, dass private Inhalte nicht ankommen.
- Antworten aus GitHub-Issues sind öffentlich (Repo ist öffentlich) → dort nie private Inhalte verarbeiten.

## Regeln, die nicht aufgeweicht werden
1. Freigaben im **Code** erzwingen (`guard.require_approval`), nie nur im Prompt. Modelltext erteilt keine Freigabe.
2. Löschen/Verschieben/Deinstallieren/Registry/Neustart/neue Skills/Änderungen an `jarvis/` → immer Freigabe.
3. Server bindet nur an `127.0.0.1`; online nur über Caddy/HTTPS mit Passwort. Ollama nur Loopback.
4. Telegram: nur gekoppelte IDs; weitergeleitete Nachrichten sind nie Befehle.
5. Keine Geheimnisse ins Repo – es ist öffentlich. Schlüssel nie in Meldungen, Logs oder Dashboard-Antworten.
6. Anbieterwechsel wiederholt nie bereits ausgeführte Werkzeuge; Einrichtungsfehler wechseln nie still.
6b. Einbahnstraße: Wissen darf herein, private Daten nie hinaus (Standard `JARVIS_PRIVACY=strikt`).
6c. Selbstverbesserung darf automatisch Routing/Prompts/Profile optimieren, aber Kerncode nie ungeprüft live überschreiben.
7. `windows/install.ps1`: nur ASCII, keine Admin-Rechte, HKCU-Autostart, nie `New-Item -Force` auf den Run-Schlüssel.
8. `hud/index.html` bleibt ein gültiges Dokument (ein `<script>`, ein `</html>`) – vor dem Commit prüfen.
