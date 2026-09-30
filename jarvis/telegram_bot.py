"""Telegram: Text, Sprachnachrichten, Dateien, Freigabe-Buttons, Push-Meldungen, NOTAUS.

Kopplung: Solange noch keine Telegram-ID eingetragen ist, zeigt das Jarvis-Fenster einen 6-stelligen
Code. Du schickst deinem Bot „/koppeln 123456“ – danach reagiert der Bot NUR noch auf dich.
"""
import asyncio
import base64
import secrets
import time
import traceback

import httpx

from . import autopilot, brain, config, db, guard, voice
from .tools import NOTIFY_HOOKS


def pair_code() -> str:
    """Aktueller Kopplungscode (nur solange niemand gekoppelt ist)."""
    if config.TELEGRAM_ALLOWED_USER_IDS:
        return ""
    code = db.get_setting("pair_code", "")
    if not code:
        code = f"{secrets.randbelow(900000) + 100000}"
        db.set_setting("pair_code", code)
        db.set_setting("pair_fails", "0")
    return code


async def _try_pair(msg: dict) -> bool:
    """Kopplung per Code. Gibt True zurück, wenn die Nachricht dadurch behandelt wurde."""
    if config.TELEGRAM_ALLOWED_USER_IDS:
        return False  # bereits gekoppelt → Fremde bekommen keinerlei Antwort
    if (msg.get("chat") or {}).get("type") != "private":
        return True
    uid, chat_id = msg["from"]["id"], msg["chat"]["id"]
    text = (msg.get("text") or "").strip()
    parts = text.split()
    if parts and parts[0].lower().split("@")[0] == "/koppeln" and len(parts) > 1:
        if secrets.compare_digest(parts[1], pair_code()):
            config.save_env({"TELEGRAM_ALLOWED_USER_IDS": str(uid)})
            db.set_setting("pair_code", "")
            db.log_action("telegram", f"gekoppelt mit ID {uid}")
            await send(chat_id, f"✅ Gekoppelt. Zu Diensten, {config.OWNER_TITLE}. Ab jetzt höre ich nur noch auf dich.\n\n"
                                + HELP)
        else:
            fails = int(db.get_setting("pair_fails", "0") or 0) + 1
            db.set_setting("pair_fails", str(fails))
            if fails >= 5:
                db.set_setting("pair_code", "")  # nach 5 Fehlversuchen neuer Code
            await send(chat_id, "❌ Falscher Code.")
        return True
    await send(chat_id, "Noch nicht gekoppelt. Öffne das Jarvis-Fenster am PC und schick mir:\n/koppeln <6-stelliger Code>")
    return True


HELP = ("Schreib oder sprich einfach mit mir.\n\n"
        "/status – Lage\n/missionen – alle Missionen\n/log <id> – Missionslog\n"
        "/pause <id> · /weiter <id> · /stopp <id>\n/ja <id> [notiz] · /nein <id> [notiz]\n"
        "/plan – geplante Aufgaben\n/skills – selbstgebaute Fähigkeiten\n/screenshot – was ist am PC los\n"
        "/notaus – sofort ALLES stoppen · /weiter – NOTAUS aufheben\n/neu – Gespräch neu beginnen")

def _api_url() -> str:
    return f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}"


def _file_url() -> str:
    return f"https://api.telegram.org/file/bot{config.TELEGRAM_BOT_TOKEN}"
_client: httpx.AsyncClient | None = None

TOOL_LABELS = {
    "list_dir": "📂 schaue in Ordner", "search_files": "🔍 suche Dateien", "delete_path": "🗑 lösche (Freigabe)",
    "move_path": "📦 verschiebe (Freigabe)", "skill_create": "🧬 baue neuen Skill", "screenshot": "👁 schaue auf den Bildschirm",
    "click": "🖱 klicke", "type_text": "⌨️ tippe", "open": "🚀 öffne", "n8n": "☁️ rufe Online-Server",
    "read_file": "📄 lese Datei",
    "web_search": "🔎 recherchiere", "fetch_url": "🌐 lese Webseite", "shell": "💻 arbeite am PC",
    "write_file": "📝 schreibe Datei", "publish_page": "🚀 veröffentliche Seite", "send_email": "✉️ sende E-Mail",
    "read_inbox": "📥 lese Postfach", "mission_create": "🎯 starte Mission", "remember": "🧠 merke mir das",
    "stripe_payment_link": "💳 erstelle Zahlungslink", "http_request": "🔌 rufe API auf",
    "schedule_create": "⏰ plane Aufgabe", "ask_owner": "🙋 frage dich",
}


async def api(method: str, files=None, **params):
    r = await _client.post(f"{_api_url()}/{method}", data=params if files else None, json=None if files else params,
                           files=files, timeout=70)
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError(f"Telegram {method}: {j.get('description')}")
    return j["result"]


async def send(chat_id: int, text: str, buttons=None):
    text = text or "…"
    chunks = [text[i:i + 4000] for i in range(0, len(text), 4000)]
    for i, ch in enumerate(chunks):
        params = {"chat_id": chat_id, "text": ch, "disable_web_page_preview": True}
        if buttons and i == len(chunks) - 1:
            params["reply_markup"] = {"inline_keyboard": buttons}
        await api("sendMessage", **params)


async def _notify_hook(text: str, approval_id: int | None = None):
    buttons = None
    if approval_id:
        buttons = [[{"text": "✅ Freigeben", "callback_data": f"ap:{approval_id}:1"},
                    {"text": "❌ Ablehnen", "callback_data": f"ap:{approval_id}:0"}]]
    for uid in config.TELEGRAM_ALLOWED_USER_IDS:
        await send(uid, text, buttons)


def _status_text() -> str:
    ms = db.q("SELECT * FROM missions WHERE status IN ('active','paused') ORDER BY id")
    lines = [f"🤖 JARVIS online | {config.active_provider()} | {config.active_model()}" + (f" | Sehen: {config.VISION_MODEL}" if config.VISION_MODEL else ""),
             "🛑 NOTAUS AKTIV – /weiter zum Aufheben" if guard.stopped() else "✅ Alle Systeme frei", ""]
    if ms:
        lines.append("🎯 Missionen:")
        for m in ms:
            prog = f" {m['current_value'] or 0:g}/{m['target_value']:g} {m['unit']}" if m["target_value"] else ""
            lines.append(f"#{m['id']} [{m['status']}] {m['title']}{prog}\n   → {m['next_step'] or '-'}")
    else:
        lines.append("Keine laufenden Missionen.")
    pend = db.q("SELECT id,question FROM approvals WHERE status='pending'")
    if pend:
        lines.append("\n🙋 Offene Freigaben: " + ", ".join(f"#{p['id']}" for p in pend))
    return "\n".join(lines)


async def _command(chat_id: int, text: str) -> bool:
    parts = text.split(maxsplit=2)
    cmd = parts[0].lower().split("@")[0]
    arg = parts[1] if len(parts) > 1 else ""
    rest = parts[2] if len(parts) > 2 else ""
    if cmd in ("/start", "/hilfe", "/help"):
        await send(chat_id, f"Zu Diensten, {config.OWNER_TITLE}. " + HELP)
    elif cmd == "/notaus":
        guard.set_stop(True)
        db.ex("UPDATE missions SET status='paused' WHERE status='active'")
        await send(chat_id, "🛑 NOTAUS. Alle Aktionen blockiert, Missionen pausiert. /weiter hebt ihn auf.")
    elif cmd == "/weiter" and not arg:
        guard.set_stop(False)
        await send(chat_id, "✅ NOTAUS aufgehoben. Pausierte Missionen startest du mit /weiter <id>.")
    elif cmd == "/skills":
        from .tools import skill_list
        await send(chat_id, await skill_list())
    elif cmd == "/screenshot":
        from . import pc
        if not pc.AVAILABLE:
            await send(chat_id, f"Bildschirm nicht verfügbar: {pc.REASON}")
        else:
            shot = await pc.screenshot()
            img = base64.b64decode(shot[1]["source"]["data"])
            await api("sendPhoto", files={"photo": ("screen.jpg", img, "image/jpeg")}, chat_id=str(chat_id))
    elif cmd == "/status":
        await send(chat_id, _status_text())
    elif cmd == "/missionen":
        from .tools import mission_list
        await send(chat_id, await mission_list())
    elif cmd == "/log" and arg.isdigit():
        from .tools import mission_log
        await send(chat_id, await mission_log(int(arg), 25))
    elif cmd in ("/pause", "/weiter", "/stopp") and arg.isdigit():
        st = {"/pause": "paused", "/weiter": "active", "/stopp": "failed"}[cmd]
        db.ex("UPDATE missions SET status=?, next_run=? WHERE id=?", (st, db.now(), int(arg)))
        db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (int(arg), db.now(), f"Owner: {cmd}"))
        await send(chat_id, f"Mission #{arg}: {st}.")
    elif cmd in ("/ja", "/nein") and arg.isdigit():
        await send(chat_id, await autopilot.answer_approval(int(arg), cmd == "/ja", rest))
    elif cmd == "/plan":
        from .tools import schedule_list
        await send(chat_id, await schedule_list())
    elif cmd == "/neu":
        db.clear_history(f"tg:{chat_id}")
        await send(chat_id, "Gesprächsverlauf geleert. Gedächtnis und Missionen bleiben.")
    else:
        return False
    return True


async def _download(file_id: str) -> tuple[bytes, str]:
    f = await api("getFile", file_id=file_id)
    r = await _client.get(f"{_file_url()}/{f['file_path']}", timeout=120)
    return r.content, f["file_path"].split("/")[-1]


async def _work(chat_id: int, text: str, reply_voice: bool):
    status_msg = await api("sendMessage", chat_id=chat_id, text="⚙️ Bin dran…")
    seen: list[str] = []
    last_edit = [0.0]
    stop = asyncio.Event()

    async def typing():
        while not stop.is_set():
            try:
                await api("sendChatAction", chat_id=chat_id, action="typing")
            except Exception:
                pass
            try:
                await asyncio.wait_for(stop.wait(), 5)
            except asyncio.TimeoutError:
                pass

    async def on_tool(name, args):
        label = TOOL_LABELS.get(name, f"🔧 {name}")
        if label not in seen:
            seen.append(label)
        if time.time() - last_edit[0] > 2:
            last_edit[0] = time.time()
            try:
                await api("editMessageText", chat_id=chat_id, message_id=status_msg["message_id"],
                          text="⚙️ " + " → ".join(seen[-6:]))
            except Exception:
                pass

    t = asyncio.create_task(typing())
    try:
        reply = await brain.chat(f"tg:{chat_id}", text, on_tool=on_tool)
    finally:
        stop.set()
        await t
        try:
            await api("deleteMessage", chat_id=chat_id, message_id=status_msg["message_id"])
        except Exception:
            pass
    await send(chat_id, reply)
    if reply_voice and voice.enabled():
        audio = await voice.speak(reply, "opus")
        if audio:
            await api("sendVoice", files={"voice": ("jarvis.ogg", audio, "audio/ogg")}, chat_id=str(chat_id))


async def _handle(update: dict):
    if "callback_query" in update:
        cq = update["callback_query"]
        if cq["from"]["id"] not in config.TELEGRAM_ALLOWED_USER_IDS:
            return
        data = cq.get("data", "")
        if data.startswith("ap:"):
            _, aid, ok = data.split(":")
            res = await autopilot.answer_approval(int(aid), ok == "1")
            await api("answerCallbackQuery", callback_query_id=cq["id"], text=res)
            msg = cq.get("message")
            if msg:
                try:
                    await api("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
                              text=msg.get("text", "") + f"\n\n→ {res}")
                except Exception:
                    pass
        return

    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return
    uid = msg["from"]["id"]
    chat_id = msg["chat"]["id"]
    if uid not in config.TELEGRAM_ALLOWED_USER_IDS:
        # Kein "first contact wins": nur per Code aus dem Jarvis-Fenster koppelbar.
        await _try_pair(msg)
        return
    if msg.get("forward_origin") or msg.get("forward_from") or msg.get("forward_sender_name"):
        await send(chat_id, "Weitergeleitete Nachrichten werden aus Sicherheitsgründen nicht als Arbeitsauftrag ausgeführt.")
        return

    text = msg.get("text") or msg.get("caption") or ""
    if text.startswith("/") and await _command(chat_id, text):
        return

    reply_voice = False
    if "voice" in msg or "audio" in msg:
        fid = (msg.get("voice") or msg.get("audio"))["file_id"]
        data, name = await _download(fid)
        try:
            heard = await voice.transcribe(data, name if "." in name else "voice.ogg")
        except Exception as e:
            await send(chat_id, f"Sprachnachricht konnte ich nicht verstehen: {e}")
            return
        await send(chat_id, f"🎙 „{heard}“")
        text = heard
        reply_voice = True

    for kind in ("document", "photo"):
        if kind in msg:
            item = msg[kind][-1] if kind == "photo" else msg[kind]
            data, name = await _download(item["file_id"])
            from pathlib import PureWindowsPath
            name = PureWindowsPath(msg.get("document", {}).get("file_name") or name).name
            if name in ("", ".", ".."):
                name = "upload.bin"
            p = config.WORKSPACE / "uploads" / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            seen = ""
            if kind == "photo" and (config.VISION_MODEL or config.active_provider() == "claude"):
                seen = "\n" + await brain.describe_image(base64.b64encode(data).decode(), question=text)
            text = (f"[{config.OWNER_NAME} hat eine Datei geschickt: {p}]{seen}\n"
                    f"{text or 'Schau sie dir an und sag mir, was du damit machen würdest.'}")

    if text.strip():
        await _work(chat_id, text, reply_voice)


_tasks: set = set()
BOT_NAME = ""


async def run():
    """Läuft für immer und stürzt nie das Gesamtprogramm ab (falscher Token, kein Internet …)."""
    while True:
        try:
            await _run_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print("Telegram-Fehler (neuer Versuch in 30 s):", e)
            await asyncio.sleep(30)


async def _run_once():
    global _client, BOT_NAME
    while not config.TELEGRAM_BOT_TOKEN:  # wartet, bis im Setup ein Token eingetragen wird
        await asyncio.sleep(5)
    token = config.TELEGRAM_BOT_TOKEN
    if _client is None:
        _client = httpx.AsyncClient()
    if _notify_hook not in NOTIFY_HOOKS:
        NOTIFY_HOOKS.append(_notify_hook)
    me = await api("getMe")
    BOT_NAME = me.get("username", "")
    db.set_setting("telegram_bot_name", BOT_NAME)
    print(f"Telegram-Bot @{BOT_NAME} läuft.")
    try:
        await api("setMyCommands", commands=[
            {"command": "status", "description": "Lage & Missionen"},
            {"command": "missionen", "description": "Alle Missionen"},
            {"command": "plan", "description": "Geplante Aufgaben"},
            {"command": "skills", "description": "Selbstgebaute Fähigkeiten"},
            {"command": "screenshot", "description": "Bildschirm vom PC"},
            {"command": "notaus", "description": "Sofort alles stoppen"},
            {"command": "weiter", "description": "NOTAUS aufheben"},
            {"command": "neu", "description": "Gespräch neu beginnen"},
            {"command": "hilfe", "description": "Alle Befehle"},
        ])
    except Exception as e:
        print("setMyCommands:", e)
    if not config.TELEGRAM_ALLOWED_USER_IDS:
        print(f"Telegram noch nicht gekoppelt. Code: {pair_code()}  → dem Bot schicken: /koppeln {pair_code()}")
    offset = int(db.get_setting("telegram_update_offset", "0") or 0)
    while config.TELEGRAM_BOT_TOKEN == token:  # Token im Setup geändert → neu verbinden
        try:
            updates = await api("getUpdates", offset=offset, timeout=50,
                                allowed_updates=["message", "callback_query"])
            for u in updates:
                offset = u["update_id"] + 1
                db.set_setting("telegram_update_offset", str(offset))
                t = asyncio.create_task(_safe(u))
                _tasks.add(t)
                t.add_done_callback(_tasks.discard)
        except Exception as e:
            print("Telegram-Polling-Fehler:", e)
            if "Unauthorized" in str(e) or "Not Found" in str(e):
                raise RuntimeError("Telegram-Token ungültig – bitte im Jarvis-Fenster neu eintragen.")
            await asyncio.sleep(5)


async def _safe(u):
    try:
        await _handle(u)
    except Exception as e:
        traceback.print_exc()
        chat = (u.get("message") or {}).get("chat", {}).get("id")
        if chat:
            try:
                await send(chat, f"Fehler: {e}")
            except Exception:
                pass
