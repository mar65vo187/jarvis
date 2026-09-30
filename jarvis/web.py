"""HUD-Server (Desktop/Browser) + öffentliche Seiten unter /s/<slug>/."""
import base64
import collections
import hashlib
import hmac
import itertools
import time
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import autopilot, brain, config, db, pc, voice, xkiro
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .tools import NOTIFY_HOOKS

HUD_DIR = Path(__file__).resolve().parent.parent / "hud"
_feed = collections.deque(maxlen=50)
_ids = itertools.count(1)


async def _notify_hook(text: str, approval_id=None):
    _feed.append({"id": next(_ids), "ts": db.now(), "text": text, "approval_id": approval_id})


NOTIFY_HOOKS.append(_notify_hook)


def _token() -> str:
    return hashlib.sha256(f"jarvis::{config.JARVIS_PASSWORD}".encode()).hexdigest()


def _provider_status():
    provider = config.active_provider()
    if provider == "claude":
        return config.CLAUDE_STATUS
    if provider == "xkiro":
        return config.XKIRO_STATUS
    return config.OLLAMA_STATUS


def _is_local(req: Request) -> bool:
    """Nur die eigene App auf diesem PC. Schutz gegen fremde Webseiten (CSRF) und DNS-Rebinding."""
    if not config.LOCAL or req.client is None or req.client.host not in ("127.0.0.1", "::1"):
        return False
    allowed = {f"127.0.0.1:{config.PORT}", f"localhost:{config.PORT}"}
    if req.headers.get("host", "") not in allowed:
        return False
    origin = req.headers.get("origin")
    if origin and origin.removeprefix("http://") not in allowed:
        return False
    if req.method != "GET" and req.headers.get("x-jarvis") != "1":
        return False
    return True


def _authed(req: Request) -> bool:
    if _is_local(req):  # eigene App auf dem eigenen PC: kein Passwort nötig
        return True
    if not config.JARVIS_PASSWORD:
        return False
    tok = req.headers.get("authorization", "").removeprefix("Bearer ").strip()
    return hmac.compare_digest(tok, _token())


def _deny():
    return JSONResponse({"error": "unauthorized"}, status_code=401)


async def _json(req):
    body = await req.json()
    if not isinstance(body, dict):
        raise ValueError("JSON-Objekt erforderlich.")
    return body


async def index(req):
    return FileResponse(HUD_DIR / "index.html")


async def static_file(req):
    name = req.path_params["name"]
    p = (HUD_DIR / name).resolve()
    if p.parent != HUD_DIR or not p.exists():
        return Response(status_code=404)
    return FileResponse(p)


async def login(req: Request):
    body = await _json(req)
    if config.JARVIS_PASSWORD and hmac.compare_digest(str(body.get("password", "")), config.JARVIS_PASSWORD):
        return JSONResponse({"token": _token(), "name": config.OWNER_NAME, "title": config.OWNER_TITLE})
    return _deny()


async def _answer(text: str, speak: bool):
    reply = await brain.chat("hud", text)
    out = {"reply": reply}
    if speak and voice.enabled():
        audio = await voice.speak(reply, "mp3")
        if audio:
            out["audio"] = base64.b64encode(audio).decode()
    return out


async def chat(req: Request):
    if not _authed(req):
        return _deny()
    body = await _json(req)
    if not isinstance(body.get("text", ""), str):
        return JSONResponse({"error": "Text muss eine Zeichenkette sein."}, status_code=400)
    text = (body.get("text") or "").strip()
    if len(text) > 100000:
        return JSONResponse({"error": "Nachricht zu lang (maximal 100.000 Zeichen)."}, status_code=400)
    if not text:
        return JSONResponse({"reply": ""})
    return JSONResponse(await _answer(text, bool(body.get("speak"))))


async def voice_in(req: Request):
    if not _authed(req):
        return _deny()
    form = await req.form()
    f = form["audio"]
    data = await f.read()
    try:
        heard = await voice.transcribe(data, f.filename or "audio.webm")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if not heard:
        return JSONResponse({"heard": "", "reply": "Ich habe nichts verstanden, Sir."})
    out = await _answer(heard, True)
    out["heard"] = heard
    return JSONResponse(out)


async def state(req: Request):
    if not _authed(req):
        return _deny()
    try:
        since = max(0, int(req.query_params.get("since", 0)))
    except ValueError:
        return JSONResponse({"error": "Ungültige Feed-ID."}, status_code=400)
    missions = db.q("SELECT id,title,status,current_value,target_value,unit,next_step,cycles,next_run "
                    "FROM missions ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, id DESC LIMIT 20")
    for m in missions:
        m["next_run_fmt"] = db.fmt_ts(m["next_run"])
    from . import guard, telegram_bot
    status = _provider_status()
    return JSONResponse({
        "model": config.active_model(),
        "vision": "Claude Vision" if config.active_provider() == "claude" else "xKiro Vision" if config.active_provider() == "xkiro" else config.VISION_MODEL,
        "provider": config.active_provider(),
        "llm": {k: v for k, v in status.items() if k != "checked"},
        "usage": {"cost_usd": db.cost_today(), "budget_usd": config.DAILY_BUDGET_USD if config.active_provider() == "claude" else 0,
                  "provider_usage": status.get("usage", "")},
        "ollama": {k: v for k, v in config.OLLAMA_STATUS.items() if k != "checked"},
        "notaus": guard.stopped(),
        "full_access": config.FULL_ACCESS,
        "skills": (db.one("SELECT COUNT(*) c FROM skills WHERE status='active'") or {"c": 0})["c"],
        "voice": voice.enabled(),
        "local": config.LOCAL, "admin": config.is_admin(), "pc": pc.AVAILABLE,
        "telegram": bool(config.TELEGRAM_BOT_TOKEN),
        "telegram_paired": bool(config.TELEGRAM_ALLOWED_USER_IDS),
        "pair_code": telegram_bot.pair_code() if config.TELEGRAM_BOT_TOKEN else "",
        "bot_name": db.get_setting("telegram_bot_name", ""),
        "missions": missions,
        "approvals": db.q("SELECT id,mission_id,kind,question,details FROM approvals WHERE status='pending' ORDER BY id"),
        "schedules": [{**s, "next_run_fmt": db.fmt_ts(s["next_run"])} for s in
                      db.q("SELECT id,description,daily_time,interval_min,next_run FROM schedules WHERE active=1 ORDER BY next_run")],
        "memory_count": (db.one("SELECT COUNT(*) c FROM memory") or {"c": 0})["c"],
        "actions": [{**a, "ts_fmt": db.fmt_ts(a["ts"])} for a in db.q("SELECT * FROM actions ORDER BY id DESC LIMIT 12")],
        "feed": [f for f in _feed if f["id"] > since],
    })


async def history(req: Request):
    if not _authed(req):
        return _deny()
    return JSONResponse(db.history("hud", 15))


async def approval(req: Request):
    if not _authed(req):
        return _deny()
    body = await _json(req)
    res = await autopilot.answer_approval(int(req.path_params["aid"]), bool(body.get("approve")), body.get("note", ""))
    return JSONResponse({"result": res})


async def mission_action(req: Request):
    if not _authed(req):
        return _deny()
    mid, action = int(req.path_params["mid"]), req.path_params["action"]
    st = {"pause": "paused", "resume": "active", "stop": "failed"}.get(action)
    if not st:
        return JSONResponse({"error": "bad action"}, status_code=400)
    db.ex("UPDATE missions SET status=?, next_run=? WHERE id=?", (st, db.now(), mid))
    db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (mid, db.now(), f"Owner: {action}"))
    return JSONResponse({"ok": True})


async def mission_log(req: Request):
    if not _authed(req):
        return _deny()
    rows = db.q("SELECT ts,entry FROM mission_log WHERE mission_id=? ORDER BY id DESC LIMIT 40",
                (int(req.path_params["mid"]),))
    return JSONResponse([{"ts": db.fmt_ts(r["ts"]), "entry": r["entry"]} for r in rows])


async def reset_chat(req: Request):
    if not _authed(req):
        return _deny()
    db.clear_history("hud")
    return JSONResponse({"ok": True})


async def app_config(req: Request):
    if not _is_local(req) and not _authed(req):
        return JSONResponse({"local": False, "needs_login": True, "needs_setup": False})
    return JSONResponse({
        "local": _is_local(req),
        "needs_login": not _is_local(req),
        "needs_setup": db.get_setting("setup_done", "0") != "1",
        "name": config.OWNER_NAME, "title": config.OWNER_TITLE, "info": config.OWNER_INFO,
        "model": config.MODEL, "vision": config.VISION_MODEL,
        "provider": config.PROVIDER, "active_provider": config.active_provider(),
        "cloud_enabled": config.CLOUD_ENABLED,
        "xkiro_model": config.XKIRO_MODEL, "xkiro_key_set": bool(config.XKIRO_API_KEY),
        "xkiro_reasoning": config.XKIRO_REASONING_EFFORT,
        "claude_model": config.CLAUDE_MODEL, "claude_key_set": bool(config.ANTHROPIC_API_KEY),
        "claude_budget": config.DAILY_BUDGET_USD,
        "telegram": bool(config.TELEGRAM_BOT_TOKEN), "voice": voice.enabled(),
    })


SETUP_KEYS = {"TELEGRAM_BOT_TOKEN", "OWNER_NAME", "OWNER_TITLE", "OWNER_INFO", "JARVIS_MODEL",
              "JARVIS_VISION_MODEL", "WHISPER_MODEL", "N8N_BASE_URL", "N8N_SECRET",
              "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "IMAP_HOST", "STRIPE_SECRET_KEY",
              "JARVIS_PROVIDER", "JARVIS_CLOUD_ENABLED", "XKIRO_API_KEY", "XKIRO_MODEL", "XKIRO_REASONING_EFFORT",
              "ANTHROPIC_API_KEY", "CLAUDE_MODEL", "CLAUDE_DAILY_BUDGET_USD"}


async def setup(req: Request):
    if not _is_local(req):
        return _deny()
    body = await _json(req)
    vals = {k: str(v).strip().replace("\n", " ").replace("\r", "") for k, v in body.items()
            if k in SETUP_KEYS and str(v).strip()}
    if vals.get("TELEGRAM_BOT_TOKEN") and vals["TELEGRAM_BOT_TOKEN"] != config.TELEGRAM_BOT_TOKEN:
        # Neuer Bot → alte Kopplung und alter Update-Offset gelten nicht mehr
        vals["TELEGRAM_ALLOWED_USER_IDS"] = ""
        db.set_setting("telegram_update_offset", "0")
        db.set_setting("pair_code", "")
    if vals:
        try:
            config.save_env(vals)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
    db.set_setting("setup_done", "1")
    from . import main as jmain
    status = await jmain.check_provider(start_if_needed=False)
    return JSONResponse({"ok": True, "saved": sorted(vals), "llm": {k: v for k, v in status.items() if k != "checked"}})


async def xkiro_models(req: Request):
    if not _is_local(req) and not _authed(req):
        return _deny()
    try:
        return JSONResponse({"models": await xkiro.list_models()})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)


async def check_ai(req: Request):
    if not _authed(req):
        return _deny()
    try:
        response = await brain._call([{"role": "user", "content": "Antworte nur mit: JARVIS BEREIT"}], max_tokens=256)
        reply = (response.get("message") or {}).get("content", "").strip()
        if not reply:
            raise RuntimeError("KI hat keinen Antworttext geliefert.")
        return JSONResponse({"ok": True, "provider": config.active_provider(), "model": config.active_model(), "reply": reply})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)


async def notaus(req: Request):
    if not _authed(req):
        return _deny()
    from . import guard
    body = await _json(req)
    on = bool(body.get("on"))
    guard.set_stop(on)
    if on:
        db.ex("UPDATE missions SET status='paused' WHERE status='active'")
    return JSONResponse({"notaus": on})


async def health(req):
    status = _provider_status()
    return JSONResponse({"ok": True, "app": "jarvis", "version": "2.0.0", "provider": config.active_provider(),
                         "ai_ready": bool(status.get("ok") and status.get("model_ok"))})


async def bad_request(req, exc):
    return JSONResponse({"error": "Ungültige JSON-Anfrage."}, status_code=400)


app = Starlette(exception_handlers={ValueError: bad_request, TypeError: bad_request},
                middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])], routes=[
    Route("/", index),
    Route("/health", health),
    Route("/api/config", app_config),
    Route("/api/setup", setup, methods=["POST"]),
    Route("/api/xkiro-models", xkiro_models),
    Route("/api/login", login, methods=["POST"]),
    Route("/api/chat", chat, methods=["POST"]),
    Route("/api/check", check_ai, methods=["POST"]),
    Route("/api/voice", voice_in, methods=["POST"]),
    Route("/api/state", state),
    Route("/api/history", history),
    Route("/api/reset", reset_chat, methods=["POST"]),
    Route("/api/notaus", notaus, methods=["POST"]),
    Route("/api/approval/{aid:int}", approval, methods=["POST"]),
    Route("/api/mission/{mid:int}/log", mission_log),
    Route("/api/mission/{mid:int}/{action}", mission_action, methods=["POST"]),
    Mount("/s", app=StaticFiles(directory=config.SITES_DIR, html=True), name="sites"),
    Route("/{name}", static_file),
])
