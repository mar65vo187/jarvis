"""Autopilot: treibt Missionen und geplante Aufgaben autonom voran – rund um die Uhr."""
import asyncio
import traceback

from . import agents, brain, config, db, prompts
from .tools import next_daily, notify

_busy = asyncio.Lock()


async def run_mission_cycle(m: dict):
    log = db.q("SELECT * FROM mission_log WHERE mission_id=? ORDER BY id DESC LIMIT 15", (m["id"],))
    log.reverse()
    approvals = db.q("SELECT * FROM approvals WHERE mission_id=? ORDER BY id DESC LIMIT 10", (m["id"],))
    ctx = {"channel": f"mission:{m['id']}", "mission_id": m["id"], "mission_updated": False}
    db.ex("UPDATE missions SET cycles=cycles+1, next_run=? WHERE id=?",
          (db.now() + config.MISSION_INTERVAL_MIN * 60, m["id"]))
    mission_text = prompts.mission_prompt(m, log, approvals)
    messages = [{"role": "user", "content": mission_text}]
    try:
        council_context = ""
        if agents.mission_review_due(m.get("cycles", 0)):
            try:
                council_context = await agents.council(
                    f"Autonome Jarvis-Mission: {m.get('title', '')}\nZiel: {m.get('goal', '')}\n"
                    f"Nächster Schritt: {m.get('next_step', '')}\n\n{mission_text[:6000]}"
                )
            except Exception:
                council_context = ""
        text = await brain.think(messages, ctx, extra_system=council_context,
                                 max_steps=config.MISSION_MAX_STEPS)
    except brain.BudgetExceeded as e:
        db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (m["id"], db.now(), str(e)))
        db.ex("UPDATE missions SET next_run=? WHERE id=?", (next_daily("00:05"), m["id"]))
        return
    if not ctx["mission_updated"]:
        db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)", (m["id"], db.now(), text[:2000]))


async def run_schedule(s: dict):
    if s["daily_time"]:
        nxt = next_daily(s["daily_time"])
    elif s["interval_min"]:
        nxt = db.now() + s["interval_min"] * 60
    else:
        nxt = None
    if nxt:
        db.ex("UPDATE schedules SET next_run=? WHERE id=?", (nxt, s["id"]))
    else:
        db.ex("UPDATE schedules SET active=0 WHERE id=?", (s["id"],))
    messages = [{"role": "user", "content":
                 f"GEPLANTE AUFGABE „{s['description']}“ ist fällig. Führe sie jetzt aus:\n{s['prompt']}\n\n"
                 f"Dein finaler Text wird {config.OWNER_NAME} automatisch als Nachricht geschickt – "
                 f"schreib ihn also direkt an ihn (kurz, auf den Punkt)."}]
    try:
        text = await brain.think(messages, {"channel": f"schedule:{s['id']}"})
    except brain.BudgetExceeded as e:
        text = str(e)
    await notify(f"⏰ {s['description']}\n\n{text}")


async def answer_approval(aid: int, approved: bool, note: str = "") -> str:
    a = db.one("SELECT * FROM approvals WHERE id=?", (aid,))
    if not a:
        return "Freigabe nicht gefunden."
    if a["status"] != "pending":
        return f"Freigabe #{aid} wurde schon beantwortet ({a['status']})."
    status = "approved" if approved else "rejected"
    db.ex("UPDATE approvals SET status=?, answer_note=?, answered=? WHERE id=?", (status, note, db.now(), aid))
    if a["mission_id"]:
        db.ex("INSERT INTO mission_log(mission_id,ts,entry) VALUES(?,?,?)",
              (a["mission_id"], db.now(), f"Owner hat Freigabe #{aid} {'ERTEILT' if approved else 'ABGELEHNT'}. {note}"))
        db.ex("UPDATE missions SET next_run=? WHERE id=? AND status IN ('active','waiting')",
              (db.now(), a["mission_id"]))
    db.log_action("freigabe", f"#{aid} {'erteilt' if approved else 'abgelehnt'}: {a['question'][:200]}")
    return f"Freigabe #{aid} {'erteilt ✅' if approved else 'abgelehnt ❌'}."


async def loop():
    print("Autopilot läuft.")
    from . import guard
    while True:
        if guard.stopped():
            await asyncio.sleep(20)
            continue
        try:
            due_s =db.q("SELECT * FROM schedules WHERE active=1 AND next_run<=?", (db.now(),))
            for s in due_s:
                asyncio.create_task(_guard(run_schedule(s)))
            if not _busy.locked():
                m = db.one("SELECT * FROM missions WHERE status='active' AND next_run<=? ORDER BY next_run LIMIT 1",
                           (db.now(),))
                if m:
                    asyncio.create_task(_mission_task(m))
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(20)


async def _mission_task(m):
    async with _busy:  # immer nur eine Mission gleichzeitig (Kosten + Übersicht)
        await _guard(run_mission_cycle(m))


async def _guard(coro):
    try:
        await coro
    except Exception as e:
        traceback.print_exc()
        await notify(f"⚠️ Autopilot-Fehler: {e}")
