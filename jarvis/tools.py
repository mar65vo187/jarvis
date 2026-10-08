"""Alle Werkzeuge, die Jarvis benutzen kann."""
import asyncio
import email
import email.header
import imaplib
import json
import os
import re
import smtplib
import ssl
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, make_msgid
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from . import config, db, guard

# Wird von telegram_bot/web gesetzt: async def(text:str, buttons:list|None)
NOTIFY_HOOKS: list = []

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


async def notify(text: str, approval_id: int | None = None):
    for hook in NOTIFY_HOOKS:
        try:
            await hook(text, approval_id)
        except Exception as e:  # noqa
            print("notify-hook error:", e)


def _cut(s: str, n: int = 15000) -> str:
    return s if len(s) <= n else s[:n] + f"\n…[gekürzt, {len(s) - n} Zeichen mehr]"


def _safe_path(p: str) -> Path:
    """Pfadauflösung: mit JARVIS_FULL_ACCESS=1 der ganze PC (Benutzerrechte), sonst nur der Workspace."""
    return guard.resolve_path(p)


# =====================================================================
# Tool-Definitionen (Schema für Claude)
# =====================================================================
def _t(name, desc, props, req=None):
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": req or []}}


S = {"type": "string"}
N = {"type": "number"}
I = {"type": "integer"}

TOOL_SCHEMAS = [
    _t("web_search", "Sucht im Internet (DuckDuckGo) und liefert Titel, Link und Kurztext der Treffer. "
                     "Danach mit fetch_url die besten Treffer lesen.",
       {"query": S, "max_results": I}, ["query"]),
    _t("fetch_url", "Lädt eine Webseite und gibt den lesbaren Text + Links zurück.",
       {"url": S, "include_links": {"type": "boolean"}}, ["url"]),
    _t("http_request", "Beliebiger HTTP-API-Aufruf (JSON). Für APIs, deren Key per get_secret verfügbar ist.",
       {"method": S, "url": S, "headers": {"type": "object"}, "json_body": {"type": "object"},
        "form": {"type": "object"}}, ["method", "url"]),
    _t("get_secret", "Liest einen hinterlegten API-Key (Umgebungsvariable SECRET_<NAME>).", {"name": S}, ["name"]),
    _t("shell", "Führt einen Befehl aus – auf Windows in PowerShell mit deinen Benutzerrechten, sonst Bash. "
                "Standard-Arbeitsordner = Workspace (cwd änderbar). Für Programme, Dateien, Einstellungen, Code, "
                "Datenverarbeitung. Löschen/Verschieben/Deinstallieren/Systemeingriffe lösen automatisch eine "
                "Freigabe-Anfrage an den Owner aus.",
       {"command": S, "timeout_sec": I, "cwd": S}, ["command"]),
    _t("write_file", "Schreibt eine Datei. Absoluter Pfad (z.B. C:\\\\Users\\\\…\\\\Desktop\\\\x.txt) oder relativ "
                     "zum Workspace. Bestehende Dateien werden vorher automatisch gesichert.",
       {"path": S, "content": S, "append": {"type": "boolean"}}, ["path", "content"]),
    _t("read_file", "Liest eine Textdatei (absolut oder relativ zum Workspace). Für Excel/Word/PDF: shell mit Python.",
       {"path": S}, ["path"]),
    _t("list_dir", "Listet einen Ordner (Name, Größe, Änderungsdatum). Ohne Pfad: Home-Ordner.",
       {"path": S}),
    _t("search_files", "Sucht Dateien nach Namensmuster (z.B. '*.pdf', '*angebot*') unterhalb eines Ordners.",
       {"folder": S, "pattern": S, "max_results": I}, ["pattern"]),
    _t("delete_path", "Löscht Datei/Ordner. Braucht IMMER Owner-Freigabe; vorher wird gesichert.",
       {"path": S}, ["path"]),
    _t("move_path", "Verschiebt/benennt Datei/Ordner um. Braucht Owner-Freigabe.",
       {"source": S, "target": S}, ["source", "target"]),
    _t("n8n", "Ruft einen Workflow auf deinem Online-Server (n8n) per Webhook auf, z.B. für Dinge, die 24/7 "
              "online laufen sollen. path = Webhook-Pfad, payload = beliebige Daten.",
       {"path": S, "payload": {"type": "object"}}, ["path"]),
    _t("skill_create", "SELBSTENTWICKLUNG: Schreibt ein neues Werkzeug (Python-Skill), das du danach dauerhaft "
                       "nutzen kannst. Code muss definieren: DESCRIPTION (str), PARAMETERS (JSON-Schema dict) "
                       "und `async def run(**kwargs) -> str`. Wird erst nach Owner-Freigabe aktiv; alte Version "
                       "bleibt als Rückfall erhalten.",
       {"name": {"type": "string", "description": "kleinbuchstaben_mit_unterstrich"}, "code": S,
        "reason": {"type": "string", "description": "Wozu der Skill gebraucht wird"}}, ["name", "code", "reason"]),
    _t("skill_list", "Listet deine selbstgebauten Skills mit Version und Status.", {}),
    _t("skill_rollback", "Setzt einen Skill auf die vorherige Version zurück oder deaktiviert ihn.",
       {"name": S, "disable": {"type": "boolean"}}, ["name"]),
    _t("publish_page", "Veröffentlicht eine komplette HTML-Seite öffentlich unter <PUBLIC_BASE_URL>/s/<slug>/. "
                       "Für Landingpages, Angebote, Portfolios. Gibt die URL zurück.",
       {"slug": S, "html": S}, ["slug", "html"]),
    _t("remember", "Speichert dauerhaftes Wissen über den Owner/sein Business. privat=true (Standard) für alles "
                   "Persönliche: wird verschlüsselt und NUR von der lokalen KI gesehen. privat=false nur für "
                   "öffentliche Geschäftsinfos.",
       {"topic": S, "content": S, "privat": {"type": "boolean"}}, ["topic", "content"]),
    _t("ask_teacher", "Fragt eine starke Cloud-KI als LEHRER – nur mit einer allgemeinen Frage ohne Namen, "
                      "Kontaktdaten oder private Details (wird geprüft). Die Antwort wird dauerhaft in deinem "
                      "eigenen Wissen gespeichert. In privaten Aufgaben muss der Owner die Frage freigeben.",
       {"question": S}, ["question"]),
    _t("recall", "Durchsucht das Langzeitgedächtnis.", {"query": S}, ["query"]),
    _t("forget", "Löscht einen Gedächtnis-Eintrag per ID.", {"id": I}, ["id"]),
    _t("mission_create", "Startet eine autonome Hintergrund-Mission, die so lange weiterläuft, bis das Ziel erreicht ist.",
       {"title": S, "goal": {"type": "string", "description": "Genaues Ziel inkl. Erfolgskriterium"},
        "target_value": {"type": "number", "description": "Zahlenziel, z.B. 500"},
        "unit": {"type": "string", "description": "z.B. EUR, Partner, Leads"},
        "plan": S}, ["title", "goal"]),
    _t("mission_update", "Aktualisiert eine Mission (Log, Plan, Fortschritt, Status, nächster Lauf).",
       {"mission_id": I, "log": S, "plan": S, "next_step": S, "current_value": N,
        "status": {"type": "string", "enum": ["active", "paused", "done", "failed"]},
        "next_run_minutes": I}, ["mission_id", "log"]),
    _t("mission_list", "Listet alle Missionen mit Status.", {}),
    _t("mission_log", "Zeigt das Log einer Mission.", {"mission_id": I, "limit": I}, ["mission_id"]),
    _t("schedule_create", "Plant eine wiederkehrende oder einmalige Aufgabe (Erinnerung, Briefing, Check). "
                          "Entweder interval_minutes ODER daily_time ('HH:MM') ODER once_at ('YYYY-MM-DD HH:MM').",
       {"description": S, "prompt": {"type": "string", "description": "Was du zu dem Zeitpunkt tun sollst"},
        "interval_minutes": I, "daily_time": S, "once_at": S}, ["description", "prompt"]),
    _t("schedule_list", "Listet geplante Aufgaben.", {}),
    _t("schedule_delete", "Löscht eine geplante Aufgabe.", {"id": I}, ["id"]),
    _t("notify_owner", "Schickt dem Owner sofort eine Push-Nachricht (Telegram + HUD).", {"text": S}, ["text"]),
    _t("ask_owner", "Bittet den Owner um Freigabe/Entscheidung/einen Handgriff. Er bekommt Ja/Nein-Buttons. "
                    "Pflicht bei Geld ausgeben (payment) und rechtlich Bindendem (legal).",
       {"kind": {"type": "string", "enum": ["payment", "legal", "decision", "action"]},
        "question": S, "details": S, "mission_id": I,
        "wait": {"type": "boolean", "description": "Im Gespräch: auf die Antwort warten (bis 5 Min.)"}},
       ["kind", "question"]),
    _t("send_email", "Sendet eine E-Mail vom Konto des Owners. Keine unaufgeforderte Werbung an Fremde (UWG).",
       {"to": S, "subject": S, "body": S, "html": {"type": "boolean"}, "reply_to_message_id": S},
       ["to", "subject", "body"]),
    _t("read_inbox", "Liest die neuesten E-Mails aus dem Posteingang.",
       {"limit": I, "unseen_only": {"type": "boolean"}, "search": {"type": "string",
        "description": "optional IMAP-Suche, z.B. FROM \"kunde@x.de\""}}),
    _t("stripe_payment_link", "Erstellt ein Stripe-Produkt + Zahlungslink (Geld EINNEHMEN).",
       {"name": S, "amount_eur": N, "description": S}, ["name", "amount_eur"]),
    _t("stripe_revenue", "Zeigt eingegangene Stripe-Zahlungen der letzten X Tage.", {"days": I}),
    _t("budget_status", "Zeigt deine heutigen KI-Kosten und das Tageslimit.", {}),
]


# =====================================================================
# Implementierungen
# =====================================================================
async def fetch_url(url: str, include_links: bool = False, **_):
    async with httpx.AsyncClient(follow_redirects=True, timeout=30, headers={"User-Agent": UA}) as c:
        r = await c.get(url)
    ctype = r.headers.get("content-type", "")
    if "html" not in ctype:
        return f"HTTP {r.status_code} ({ctype})\n" + _cut(r.text, 12000)
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else ""
    text = re.sub(r"\n{3,}", "\n\n", soup.get_text("\n", strip=True))
    out = f"HTTP {r.status_code} | {title}\n\n{_cut(text, 14000)}"
    if include_links:
        links = []
        for a in soup.find_all("a", href=True)[:80]:
            links.append(f"{a.get_text(strip=True)[:60]} -> {httpx.URL(str(r.url)).join(a['href'])}")
        out += "\n\nLINKS:\n" + "\n".join(links)
    return out


async def http_request(method: str, url: str, headers=None, json_body=None, form=None, **_):
    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as c:
        r = await c.request(method.upper(), url, headers=headers or {}, json=json_body, data=form)
    db.log_action("http", f"{method} {url} -> {r.status_code}")
    return f"HTTP {r.status_code}\n{_cut(r.text, 12000)}"


async def get_secret(name: str, **_):
    s = config.secrets()
    key = name.upper().removeprefix("SECRET_")
    return s.get(key) or f"Kein Secret '{key}'. Verfügbar: {', '.join(s) or 'keine'}"


def _ddg_parse(html: str, max_results: int) -> list[dict]:
    from urllib.parse import parse_qs, unquote, urlparse
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for res in soup.select("div.result, div.web-result"):
        a = res.select_one("a.result__a")
        if not a or not a.get("href"):
            continue
        href = a["href"]
        if "uddg=" in href:
            href = unquote(parse_qs(urlparse(href if "://" in href else "https:" + href).query).get("uddg", [href])[0])
        if "duckduckgo.com/y.js" in href:  # Anzeigen überspringen
            continue
        snip = res.select_one(".result__snippet")
        out.append({"title": a.get_text(" ", strip=True), "url": href,
                    "snippet": snip.get_text(" ", strip=True) if snip else ""})
        if len(out) >= max_results:
            break
    return out


async def web_search(query: str, max_results: int = 8, **_):
    max_results = max(1, min(int(max_results or 8), 15))
    async with httpx.AsyncClient(follow_redirects=True, timeout=25, headers={"User-Agent": UA}) as c:
        r = await c.post("https://html.duckduckgo.com/html/", data={"q": query, "kl": "de-de"})
    hits = _ddg_parse(r.text, max_results)
    if not hits:
        return f"Keine Treffer für „{query}“ (HTTP {r.status_code}). Anders formulieren oder fetch_url direkt nutzen."
    return "\n\n".join(f"{i}. {h['title']}\n   {h['url']}\n   {h['snippet']}" for i, h in enumerate(hits, 1))


async def shell(command: str, timeout_sec: int | None = None, cwd: str = "", _ctx=None, **_):
    if guard.stopped():
        return "NOTAUS aktiv – nichts ausgeführt."
    risk = guard.shell_risk(command)
    if risk:
        ok, msg = await guard.require_approval(
            "action", f"Shell-Befehl ausführen (enthält „{risk}“):\n{command[:1500]}", ctx=_ctx)
        if not ok:
            return msg
    timeout = min(timeout_sec or config.SHELL_TIMEOUT, 900)
    workdir = _safe_path(cwd) if cwd else config.WORKSPACE
    if config.IS_WINDOWS:
        ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " + command
        proc = await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps,
            cwd=workdir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            creationflags=0x08000000)  # kein Konsolenfenster
    else:
        proc = await asyncio.create_subprocess_shell(
            command, cwd=workdir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            executable="/bin/bash")
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return f"TIMEOUT nach {timeout}s"
    db.log_action("shell", command[:300])
    return f"exit={proc.returncode}\n{_cut(out.decode(errors='replace'), 12000)}"


async def write_file(path: str, content: str, append: bool = False, _ctx=None, **_):
    if guard.stopped():
        return "NOTAUS aktiv – nichts geschrieben."
    p = _safe_path(path)
    if guard.is_core_path(p):
        ok, msg = await guard.require_approval("action", f"Jarvis-Programmcode ändern: {p}",
                                               content[:1200], ctx=_ctx)
        if not ok:
            return msg
    saved = guard.backup(p) if p.exists() and not append else None
    p.parent.mkdir(parents=True, exist_ok=True)
    if append:
        with p.open("a", encoding="utf-8") as f:
            f.write(content)
    else:
        p.write_text(content, encoding="utf-8")
    db.log_action("datei", f"{'ergänzt' if append else 'geschrieben'}: {p}")
    return f"Gespeichert: {p} ({len(content)} Zeichen)" + (f" · Sicherung: {saved}" if saved else "")


async def read_file(path: str, **_):
    p = _safe_path(path)
    if not p.exists():
        return "Datei existiert nicht."
    if p.is_dir():
        return await list_dir(str(p))
    return _cut(p.read_text(encoding="utf-8", errors="replace"), 20000)


async def list_dir(path: str = "", **_):
    p = _safe_path(path) if path else config.HOME
    if not p.exists():
        return "Ordner existiert nicht."
    rows = []
    try:
        entries = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except PermissionError:
        return f"Kein Zugriff auf {p} (Windows-Rechte)."
    for e in entries[:300]:
        try:
            st = e.stat()
            size = "<DIR>" if e.is_dir() else f"{st.st_size / 1024:.0f} KB"
            rows.append(f"{size:>10}  {datetime.fromtimestamp(st.st_mtime).strftime('%d.%m.%y %H:%M')}  {e.name}")
        except OSError:
            rows.append(f"{'?':>10}  {'':14}  {e.name}")
    more = f"\n… und {len(entries) - 300} weitere" if len(entries) > 300 else ""
    return f"{p}\n" + "\n".join(rows) + more if rows else f"{p} ist leer."


async def search_files(pattern: str, folder: str = "", max_results: int = 50, **_):
    base = _safe_path(folder) if folder else config.HOME
    max_results = max(1, min(int(max_results or 50), 300))

    def _find():
        out = []
        skip = {"AppData", "node_modules", ".git", "$Recycle.Bin", "Windows", ".venv", "__pycache__"}
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
            for name in dirs + files:
                if Path(name).match(pattern) or pattern.lower().strip("*") in name.lower():
                    out.append(os.path.join(root, name))
                    if len(out) >= max_results:
                        return out
        return out
    hits = await asyncio.to_thread(_find)
    return "\n".join(hits) or f"Nichts gefunden für „{pattern}“ unter {base}."


async def delete_path(path: str, _ctx=None, **_):
    p = _safe_path(path)
    if not p.exists():
        return "Existiert nicht."
    ok, msg = await guard.require_approval("action", f"LÖSCHEN: {p}", ctx=_ctx)
    if not ok:
        return msg
    saved = guard.backup(p)
    import shutil
    shutil.rmtree(p) if p.is_dir() else p.unlink()
    db.log_action("löschen", f"{p} (Sicherung: {saved})")
    return f"Gelöscht: {p}. Sicherung liegt in {saved}."


async def move_path(source: str, target: str, _ctx=None, **_):
    s, t = _safe_path(source), _safe_path(target)
    if not s.exists():
        return "Quelle existiert nicht."
    ok, msg = await guard.require_approval("action", f"VERSCHIEBEN: {s} → {t}", ctx=_ctx)
    if not ok:
        return msg
    import shutil
    t.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(s), str(t))
    db.log_action("verschieben", f"{s} → {t}")
    return f"Verschoben: {s} → {t}"


async def n8n(path: str, payload: dict | None = None, **_):
    if not config.N8N_BASE_URL:
        return "Online-Server nicht eingerichtet (N8N_BASE_URL fehlt in .env)."
    url = f"{config.N8N_BASE_URL}/webhook/{path.strip('/')}"
    headers = {"X-Jarvis-Secret": config.N8N_SECRET} if config.N8N_SECRET else {}
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(url, json=payload or {}, headers=headers)
    db.log_action("n8n", f"{path} -> {r.status_code}")
    return f"HTTP {r.status_code}\n{_cut(r.text, 8000)}"


# ---------------------------------------------------------------- Selbstentwicklung (Skills)
async def skill_create(name: str, code: str, reason: str, _ctx=None, **_):
    from . import skills
    return await skills.create(name, code, reason, _ctx)


async def skill_list(**_):
    from . import skills
    return skills.describe()


async def skill_rollback(name: str, disable: bool = False, **_):
    from . import skills
    return skills.rollback(name, disable)


async def publish_page(slug: str, html: str, **_):
    slug = re.sub(r"[^a-z0-9-]", "-", slug.lower()).strip("-")[:60] or "seite"
    d = config.SITES_DIR / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.html").write_text(html, encoding="utf-8")
    url = f"{config.PUBLIC_BASE_URL}/s/{slug}/"
    if config.LOCAL:
        url += " (nur lokal auf diesem PC erreichbar – für öffentliche Seiten extern hosten)"
    db.log_action("publish", url)
    return f"Veröffentlicht: {url}"


async def remember(topic: str, content: str, privat: bool = True, **_):
    from . import privacy
    if not privat:
        findings = privacy.sensitive_findings(f"{topic}\n{content}")
        if findings:
            return ("BLOCKIERT: öffentliche Gedächtniseinträge dürfen keine persönlichen Angaben enthalten (" +
                    ", ".join(findings) + "). Nutze privat=true.")
    stored_topic = privacy.encrypt(topic) if privat else topic
    stored_content = privacy.encrypt(content) if privat else content
    i = db.ex("INSERT INTO memory(topic,content,ts,private) VALUES(?,?,?,?)",
              (stored_topic, stored_content, db.now(), 1 if privat else 0))
    return f"Gemerkt (#{i}, {'privat/verschlüsselt' if privat else 'öffentlich'})."


async def recall(query: str, **_):
    from . import privacy
    words = [w for w in re.split(r"\W+", query.lower()) if len(w) > 2][:6] or [query.lower()]
    out = []
    for r in db.q("SELECT * FROM memory ORDER BY id DESC LIMIT 2000"):
        topic = privacy.decrypt(r["topic"])
        text = privacy.decrypt(r["content"])
        if any(w in (text + " " + topic).lower() for w in words):
            out.append(f"#{r['id']} [{topic}] {text}")
            if len(out) >= 30:
                break
    return "\n".join(out) or "Nichts gefunden."


def teacher_provider() -> str | None:
    """Cloud-KI, die als Lehrer gefragt werden darf (unabhängig vom Privatsphäre-Modus)."""
    if not config.CLOUD_ENABLED:
        return None
    p = config.active_provider()
    if p != "ollama":
        return p
    if config.XKIRO_API_KEY:
        return "xkiro"
    if config.HF_TOKEN:
        return "huggingface"
    if config.ANTHROPIC_API_KEY:
        return "claude"
    return None


async def ask_teacher(question: str, _ctx=None, **_):
    from . import brain, knowledge, privacy
    question = (question or "").strip()
    if not question:
        return "Keine Frage angegeben."
    provider = teacher_provider()
    if not provider:
        return "Kein Lehrer verfügbar (Cloud gesperrt oder kein API-Schlüssel). Arbeite mit eigenem Wissen weiter."
    found = privacy.sensitive_findings(question)
    if found:
        return ("BLOCKIERT – die Frage enthält persönliche Daten (" + ", ".join(found) + "). Formuliere sie "
                "allgemein, ohne Namen, Kontaktdaten oder private Details, und frage erneut.")
    if _ctx and _ctx.get("private"):  # Aufgabe hat private Daten berührt → Owner sieht die Frage vorher
        ok, msg = await guard.require_approval(
            "action", f"Lehrer-Frage an {config.provider_label(provider)} senden (nur diese Frage, kein Verlauf):",
            question[:1500], ctx=_ctx)
        if not ok:
            return msg
    resp = await brain._cloud_call(provider, [
        {"role": "system", "content": "Du bist ein Lehrer für einen persönlichen KI-Assistenten. Antworte auf Deutsch, "
                                      "sachlich, vollständig und allgemein gültig, mit konkreten Schritten."},
        {"role": "user", "content": question}], None, 2000, None)
    answer = ((resp.get("message") or {}).get("content") or "").strip()
    kid = knowledge.learn(question, answer, config.provider_label(provider))
    db.log_action("lehrer", f"{config.provider_label(provider)}: {question[:120]}" + (f" → Wissen #{kid}" if kid else ""))
    return answer or "Der Lehrer hat keine Antwort geliefert."


async def forget(id: int, **_):
    db.ex("DELETE FROM memory WHERE id=?", (id,))
    return "Gelöscht."


async def mission_create(title: str, goal: str, target_value=None, unit: str = "", plan: str = "", _ctx=None, **_):
    mid = db.ex(
        "INSERT INTO missions(title,goal,target_value,unit,plan,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?)",
        (title, goal, target_value, unit, plan, db.now() + 5, db.now(), db.now()))
    db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (mid, db.now(), "Mission gestartet."))
    db.log_action("mission", f"#{mid} {title}")
    return f"Mission #{mid} gestartet. Sie läuft ab jetzt autonom im Hintergrund (erster Zyklus in Sekunden)."


async def mission_update(mission_id: int, log: str, plan=None, next_step=None, current_value=None,
                         status=None, next_run_minutes=None, _ctx=None, **_):
    m = db.one("SELECT * FROM missions WHERE id=?", (mission_id,))
    if not m:
        return "Mission nicht gefunden."
    sets, args = ["updated=?"], [db.now()]
    for col, val in (("plan", plan), ("next_step", next_step), ("current_value", current_value), ("status", status)):
        if val is not None:
            sets.append(f"{col}=?")
            args.append(val)
    if next_run_minutes is not None:
        sets.append("next_run=?")
        args.append(db.now() + max(1, int(next_run_minutes)) * 60)
    db.ex(f"UPDATE missions SET {', '.join(sets)} WHERE id=?", (*args, mission_id))
    db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (mission_id, db.now(), log))
    if _ctx is not None:
        _ctx["mission_updated"] = True
    if status in ("done", "failed"):
        await notify(f"Mission #{mission_id} „{m['title']}“: {'ERREICHT ✅' if status == 'done' else 'gestoppt ❌'}\n{log}")
    return "Mission aktualisiert."


async def mission_list(**_):
    rows = db.q("SELECT * FROM missions ORDER BY id DESC LIMIT 30")
    return "\n".join(
        f"#{m['id']} [{m['status']}] {m['title']} | {m['current_value'] or 0:g}/{m['target_value'] or 0:g} {m['unit']} "
        f"| Zyklen {m['cycles']} | nächster Lauf {db.fmt_ts(m['next_run'])} | next: {m['next_step']}"
        for m in rows) or "Keine Missionen."


async def mission_log(mission_id: int, limit: int = 30, **_):
    rows = db.q("SELECT * FROM mission_log WHERE mission_id=? ORDER BY id DESC LIMIT ?", (mission_id, limit))
    return "\n".join(f"{db.fmt_ts(r['ts'])}: {r['entry']}" for r in reversed(rows)) or "Leer."


def _parse_local(s: str) -> float:
    dt = datetime.strptime(s.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=config.TIMEZONE)
    return dt.timestamp()


def next_daily(hhmm: str) -> float:
    h, m = [int(x) for x in hhmm.split(":")]
    now = datetime.now(config.TIMEZONE)
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if t <= now:
        t += timedelta(days=1)
    return t.timestamp()


async def schedule_create(description: str, prompt: str, interval_minutes=None, daily_time=None, once_at=None, **_):
    if daily_time:
        nxt = next_daily(daily_time)
    elif once_at:
        nxt = _parse_local(once_at)
    elif interval_minutes:
        nxt = db.now() + int(interval_minutes) * 60
    else:
        return "Bitte interval_minutes, daily_time oder once_at angeben."
    i = db.ex("INSERT INTO schedules(description,prompt,interval_min,daily_time,next_run,created) VALUES(?,?,?,?,?,?)",
              (description, prompt, interval_minutes, daily_time, nxt, db.now()))
    return f"Geplant (#{i}), erster Lauf {db.fmt_ts(nxt)}."


async def schedule_list(**_):
    rows = db.q("SELECT * FROM schedules WHERE active=1 ORDER BY next_run")
    out = []
    for r in rows:
        if r["daily_time"]:
            when = "täglich " + r["daily_time"]
        elif r["interval_min"]:
            when = f"alle {r['interval_min']} min"
        else:
            when = "einmalig"
        out.append(f"#{r['id']} {r['description']} | {when} | nächster Lauf {db.fmt_ts(r['next_run'])}")
    return "\n".join(out) or "Nichts geplant."


async def schedule_delete(id: int, **_):
    db.ex("UPDATE schedules SET active=0 WHERE id=?", (id,))
    return "Gelöscht."


async def notify_owner(text: str, **_):
    await notify(text)
    return "Gesendet."


async def ask_owner(kind: str, question: str, details: str = "", mission_id=None, wait: bool = False, _ctx=None, **_):
    if mission_id is None and _ctx:
        mission_id = _ctx.get("mission_id")
    aid = db.ex("INSERT INTO approvals(mission_id,kind,question,details,created) VALUES(?,?,?,?,?)",
                (mission_id, kind, question, details, db.now()))
    icon = {"payment": "💶", "legal": "⚖️", "decision": "🧭", "action": "🛠"}.get(kind, "❓")
    txt = f"{icon} FREIGABE #{aid}" + (f" (Mission #{mission_id})" if mission_id else "") + f"\n{question}"
    if details:
        txt += f"\n\n{details}"
    await notify(txt, aid)
    if wait or (_ctx and str(_ctx.get("channel", "")).startswith(("tg:", "hud"))):
        for _ in range(config.APPROVAL_WAIT_SEC // 2):
            await asyncio.sleep(2)
            a = db.one("SELECT status, answer_note FROM approvals WHERE id=?", (aid,))
            if a["status"] != "pending":
                return f"Antwort auf #{aid}: {a['status'].upper()}. {a['answer_note']}"
        return f"Keine Antwort auf #{aid} innerhalb von {config.APPROVAL_WAIT_SEC // 60} Min. Nicht ausführen."
    return (f"Anfrage #{aid} an Owner geschickt. Du wirst informiert, sobald er antwortet. "
            f"Arbeite bis dahin an allem weiter, was nicht davon abhängt.")


def _smtp_send(msg, to_list):
    ctx = ssl.create_default_context()
    if config.SMTP_PORT == 465:
        with smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=ctx, timeout=30) as s:
            s.login(config.SMTP_USER, config.SMTP_PASS)
            s.sendmail(config.SMTP_FROM, to_list, msg.as_string())
    else:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(config.SMTP_USER, config.SMTP_PASS)
            s.sendmail(config.SMTP_FROM, to_list, msg.as_string())


async def send_email(to: str, subject: str, body: str, html: bool = False, reply_to_message_id: str = "", **_):
    if not config.SMTP_HOST:
        return "E-Mail ist nicht eingerichtet (SMTP_* in .env fehlt). Bitte Owner via ask_owner(kind='action')."
    to_list = [x.strip() for x in re.split(r"[,;]", to) if x.strip()]
    msg = MIMEMultipart("alternative")
    msg["From"] = formataddr((config.OWNER_NAME, config.SMTP_FROM))
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid()
    if reply_to_message_id:
        msg["In-Reply-To"] = reply_to_message_id
        msg["References"] = reply_to_message_id
    msg.attach(MIMEText(body, "html" if html else "plain", "utf-8"))
    await asyncio.to_thread(_smtp_send, msg, to_list)
    db.log_action("email", f"an {to}: {subject}")
    return f"E-Mail gesendet an {to}."


def _decode(h):
    if not h:
        return ""
    parts = email.header.decode_header(h)
    return "".join(p.decode(enc or "utf-8", errors="replace") if isinstance(p, bytes) else p for p, enc in parts)


def _imap_read(limit, unseen_only, search):
    m = imaplib.IMAP4_SSL(config.IMAP_HOST)
    m.login(config.IMAP_USER, config.IMAP_PASS)
    m.select("INBOX", readonly=True)
    crit = search or ("UNSEEN" if unseen_only else "ALL")
    _, data = m.search(None, crit)
    ids = data[0].split()[-limit:]
    out = []
    for i in reversed(ids):
        _, d = m.fetch(i, "(RFC822)")
        msg = email.message_from_bytes(d[0][1])
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition")):
                    body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                    break
            if not body:
                for part in msg.walk():
                    if part.get_content_type() == "text/html":
                        raw = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                        body = BeautifulSoup(raw, "html.parser").get_text("\n", strip=True)
                        break
        else:
            raw = msg.get_payload(decode=True) or b""
            body = raw.decode(msg.get_content_charset() or "utf-8", errors="replace")
        out.append(f"--- Message-ID: {msg.get('Message-ID')}\nVon: {_decode(msg.get('From'))}\nDatum: {msg.get('Date')}\n"
                   f"Betreff: {_decode(msg.get('Subject'))}\n\n{body[:3000]}")
    m.logout()
    return "\n\n".join(out) or "Keine Mails."


async def read_inbox(limit: int = 10, unseen_only: bool = False, search: str = "", **_):
    if not config.IMAP_HOST:
        return "Posteingang nicht eingerichtet (IMAP_* in .env fehlt)."
    return _cut(await asyncio.to_thread(_imap_read, min(limit, 30), unseen_only, search), 25000)


async def _stripe(method, path, data=None, params=None):
    async with httpx.AsyncClient(timeout=30, auth=(config.STRIPE_SECRET_KEY, "")) as c:
        r = await c.request(method, f"https://api.stripe.com/v1/{path}", data=data, params=params)
    j = r.json()
    if r.status_code >= 400:
        raise RuntimeError(j.get("error", {}).get("message", r.text))
    return j


async def stripe_payment_link(name: str, amount_eur: float, description: str = "", **_):
    if not config.STRIPE_SECRET_KEY:
        return "Stripe nicht eingerichtet (STRIPE_SECRET_KEY fehlt). Bitte Owner via ask_owner(kind='action')."
    prod = await _stripe("POST", "products", {"name": name, **({"description": description} if description else {})})
    price = await _stripe("POST", "prices", {"product": prod["id"], "currency": "eur",
                                             "unit_amount": int(round(amount_eur * 100))})
    link = await _stripe("POST", "payment_links", {"line_items[0][price]": price["id"],
                                                   "line_items[0][quantity]": 1})
    db.log_action("stripe", f"Zahlungslink {name} {amount_eur}€: {link['url']}")
    return f"Zahlungslink: {link['url']}"


async def stripe_revenue(days: int = 30, **_):
    if not config.STRIPE_SECRET_KEY:
        return "Stripe nicht eingerichtet."
    since = int(db.now() - days * 86400)
    j = await _stripe("GET", "charges", params={"limit": 100, "created[gte]": since})
    ok = [c for c in j["data"] if c["status"] == "succeeded" and not c.get("refunded")]
    total = sum(c["amount"] for c in ok) / 100
    lines = [f"{db.fmt_ts(c['created'])}: {c['amount'] / 100:.2f} € – {c.get('description') or c.get('billing_details', {}).get('email') or ''}"
             for c in ok[:30]]
    return f"Umsatz letzte {days} Tage: {total:.2f} € ({len(ok)} Zahlungen)\n" + "\n".join(lines)


async def budget_status(**_):
    return f"Heute verbraucht: ${db.cost_today():.2f} von ${config.DAILY_BUDGET_USD:.2f} Tageslimit."


HANDLERS = {
    "web_search": web_search, "list_dir": list_dir, "search_files": search_files,
    "delete_path": delete_path, "move_path": move_path, "n8n": n8n,
    "skill_create": skill_create, "skill_list": skill_list, "skill_rollback": skill_rollback,
    "fetch_url": fetch_url, "http_request": http_request, "get_secret": get_secret, "shell": shell,
    "write_file": write_file, "read_file": read_file, "publish_page": publish_page,
    "remember": remember, "recall": recall, "forget": forget, "ask_teacher": ask_teacher,
    "mission_create": mission_create, "mission_update": mission_update, "mission_list": mission_list,
    "mission_log": mission_log, "schedule_create": schedule_create, "schedule_list": schedule_list,
    "schedule_delete": schedule_delete, "notify_owner": notify_owner, "ask_owner": ask_owner,
    "send_email": send_email, "read_inbox": read_inbox, "stripe_payment_link": stripe_payment_link,
    "stripe_revenue": stripe_revenue, "budget_status": budget_status,
}
CTX_TOOLS = {"mission_create", "mission_update", "ask_owner", "shell", "write_file", "delete_path",
             "move_path", "skill_create", "ask_teacher"}
# Werkzeuge, die jederzeit laufen dürfen, auch bei NOTAUS (nur lesen / informieren).
READ_ONLY = {"web_search", "fetch_url", "read_file", "list_dir", "search_files", "recall", "mission_list",
             "mission_log", "schedule_list", "skill_list", "notify_owner", "ask_owner", "get_secret",
             "screenshot", "windows", "system_status", "wait", "budget_status", "stripe_revenue", "read_inbox"}

# PC-Steuerung (nur lokal mit Bildschirm)
from . import pc  # noqa: E402

if pc.AVAILABLE:
    TOOL_SCHEMAS.extend(pc.SCHEMAS)
    HANDLERS.update(pc.HANDLERS)

# Nicht eingerichtete Integrationen werden dem Modell gar nicht erst angeboten (kleine Modelle
# arbeiten mit weniger, passenderen Werkzeugen deutlich zuverlässiger).
_NEEDS = {
    "send_email": lambda: bool(config.SMTP_HOST), "read_inbox": lambda: bool(config.IMAP_HOST),
    "stripe_payment_link": lambda: bool(config.STRIPE_SECRET_KEY),
    "stripe_revenue": lambda: bool(config.STRIPE_SECRET_KEY),
    "n8n": lambda: bool(config.N8N_BASE_URL), "budget_status": lambda: config.active_provider() == "claude",
}


def all_schemas() -> list[dict]:
    from . import skills
    base = [t for t in TOOL_SCHEMAS if _NEEDS.get(t["name"], lambda: True)()]
    return base + skills.schemas()


async def run_tool(name: str, args: dict, ctx: dict) -> tuple:
    from . import skills
    fn = HANDLERS.get(name) or skills.handler(name)
    if not fn:
        return f"Unbekanntes Tool {name}", True
    if guard.stopped() and name not in READ_ONLY:
        return "NOTAUS aktiv – Aktion blockiert. Owner muss /weiter senden.", True
    from . import privacy
    ctx = ctx if ctx is not None else {}
    # Ausgangsschleuse: in privaten Aufgaben verlässt nichts Persönliches Jarvis
    if name in privacy.OUTBOUND_TOOLS and privacy.must_stay_local(ctx=ctx):
        payload = json.dumps({k: v for k, v in args.items() if not k.startswith("_")}, ensure_ascii=False)
        if name in ("web_search", "fetch_url"):
            found = privacy.sensitive_findings(payload)
            if found:
                return ("BLOCKIERT (Privatsphäre): Suchanfrage/Adresse enthält persönliche Daten (" + ", ".join(found)
                        + "). Suche allgemein formulieren."), True
        elif name in privacy.OUTBOUND_NEEDS_APPROVAL:
            ok, msg = await guard.require_approval(
                "action", f"PRIVATE Aufgabe: Daten mit „{name}“ nach draußen senden?", payload[:1800], ctx=ctx)
            if not ok:
                return msg, True
    try:
        if name in CTX_TOOLS:
            args = {**args, "_ctx": ctx}
        else:
            args = {k: v for k, v in args.items() if not k.startswith("_")}
        res = await fn(**args)
        # Markierung: Ergebnisse aus privaten Quellen (und eigene Skills) machen die Aufgabe privat
        if name in privacy.PRIVATE_SOURCE_TOOLS or name not in HANDLERS:
            ctx["private"] = True
        if isinstance(res, list):  # z.B. Screenshot: Text + Bild
            return res, False
        return (res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)), False
    except Exception as e:
        if type(e).__name__ == "FailSafeException":
            return "NOTAUS: Owner hat die Maus in die Bildschirmecke gezogen. Sofort stoppen und nachfragen.", True
        return f"FEHLER in {name}: {type(e).__name__}: {e}", True
