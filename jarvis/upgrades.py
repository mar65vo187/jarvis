"""Evolution/upgrade engine for Jarvis specialist agents.

This evolves agent profiles (instructions + model preferences), not foundation
model weights. Candidates are benchmarked blind against their parent and only
promoted when they improve.
"""
import asyncio
import json
import re
import time

from . import agents, config, db, model_pool

FOCI = ("code", "research", "business", "general")
BASE_ROLE = {"code": "engineer", "research": "researcher", "business": "analyst", "general": "strategist"}

BENCH = {
    "code": [
        "Entwirf einen robusten Fix-Plan für eine Python-Webapp, deren Login sporadisch 500 liefert. Nenne Tests und Rollback.",
        "Prüfe eine Multi-Agent-Architektur auf Race Conditions, doppelte Side Effects und fehlende Observability.",
        "Plane eine sichere Migration einer SQLite-App auf eine neue Schema-Version ohne Datenverlust.",
    ],
    "research": [
        "Entwirf einen Rechercheplan für eine aktuelle technische Behauptung. Trenne Primärquellen, Gegenbelege und Unsicherheit.",
        "Vergleiche zwei unbekannte KI-Anbieter methodisch, ohne Marketingaussagen ungeprüft zu übernehmen.",
        "Erstelle eine Verifikationsstrategie für eine zeitkritische Information mit widersprüchlichen Quellen.",
    ],
    "business": [
        "Entwirf eine messbare Vertriebsstrategie mit Funnel, Hypothesen, Risiken und Stop-Kriterien.",
        "Prüfe ein neues Abo-Angebot auf Wertversprechen, Unit Economics, Missbrauchsrisiken und Testdesign.",
        "Plane eine Partnerstrategie, die Wachstum ermöglicht ohne Abhängigkeit von nur einem Anbieter.",
    ],
    "general": [
        "Zerlege ein komplexes Ziel in reversible Schritte, messbare Erfolgskriterien und klare Abbruchbedingungen.",
        "Finde blinde Flecken in einem ambitionierten Automatisierungsprojekt und schlage eine robuste Reihenfolge vor.",
        "Entwirf einen Plan, der Geschwindigkeit und Qualitätskontrolle gleichzeitig optimiert.",
    ],
}

LAST = {"running": False, "ts": 0.0, "status": "noch nicht gelaufen", "focus": "", "score": 0.0, "candidate": ""}


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise ValueError("Factory lieferte kein JSON.")
        return json.loads(m.group(0))


def _parent(focus: str) -> agents.AgentSpec:
    row = db.one("SELECT * FROM agent_profiles WHERE status='active' AND task_type=? ORDER BY score DESC,generation DESC LIMIT 1",
                 (focus,))
    if row:
        return agents.custom_specs().get(row["key"]) or agents.SPECS[BASE_ROLE[focus]]
    return agents.SPECS[BASE_ROLE[focus]]


def _next_focus() -> str:
    idx = int(db.get_setting("upgrade_focus_index", "0") or 0) % len(FOCI)
    db.set_setting("upgrade_focus_index", str((idx + 1) % len(FOCI)))
    return FOCI[idx]


def _candidate_spec(data: dict, focus: str, parent: agents.AgentSpec) -> agents.AgentSpec:
    mission = re.sub(r"\s+", " ", str(data.get("mission") or "")).strip()[:900]
    if len(mission) < 80:
        raise ValueError("Candidate-Mission ist zu kurz.")
    raw_name = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("name") or "EVOLVED"))[:24].upper() or "EVOLVED"
    vendors = tuple(str(x).lower()[:40] for x in (data.get("vendors") or parent.vendors) if str(x).strip())[:8]
    key = f"evo_{focus}_{int(time.time())}"
    return agents.AgentSpec(
        key, raw_name, mission, vendors or parent.vendors,
        bool(data.get("reasoning", True)), bool(data.get("web_search", parent.web_search)),
        focus, parent.generation + 1,
    )


async def _answer(spec: agents.AgentSpec, task: str, row: dict) -> str:
    result = await model_pool.call(row, agents._prompt(spec, task), max_tokens=min(900, config.AGENT_MAX_TOKENS),
                                   reasoning_effort="high", web_search=False)
    return ((result.get("message") or {}).get("content") or "").strip()


async def _judge(task: str, a: str, b: str, row: dict) -> str:
    prompt = [
        {"role": "system", "content":
         "Du bist ein strenger blinder Benchmark-Judge. Bewerte nur Qualität: Korrektheit, Robustheit, konkrete Umsetzung, "
         "Unsicherheitsmanagement und Prüfbarkeit. Bevorzuge keine längere Antwort. Antworte NUR als JSON: "
         '{"winner":"A|B|TIE","reason":"kurz"}.'},
        {"role": "user", "content": f"AUFGABE:\n{task}\n\nANTWORT A:\n{a[:7000]}\n\nANTWORT B:\n{b[:7000]}"},
    ]
    out = await model_pool.call(row, prompt, max_tokens=250, reasoning_effort="high")
    data = _extract_json(((out.get("message") or {}).get("content") or ""))
    winner = str(data.get("winner") or "TIE").upper()
    return winner if winner in ("A", "B", "TIE") else "TIE"


async def _propose(parent: agents.AgentSpec, focus: str, row: dict) -> agents.AgentSpec:
    prompt = [
        {"role": "system", "content":
         "Du bist JARVIS AGENT FACTORY. Erzeuge eine verbesserte Spezialisierung als Prompt-Agent, keine neuen Modellgewichte. "
         "Der Agent darf nur beraten, keine externen Aktionen behaupten. Antworte ausschließlich als JSON mit "
         'name, mission, vendors (Array), reasoning (bool), web_search (bool).'},
        {"role": "user", "content":
         f"DOMÄNE: {focus}\nELTERN-AGENT: {parent.name}\nELTERN-MISSION: {parent.mission}\n"
         "Verbessere Präzision, Gegenprüfung, Fehlererkennung, Prüfbarkeit und Tokenökonomie. "
         "Der Child-Agent soll mindestens gleich gut, aber möglichst schneller und knapper arbeiten. "
         "Die Mission soll 100-500 Wörter kurz bleiben."},
    ]
    out = await model_pool.call(row, prompt, max_tokens=700, reasoning_effort="high")
    return _candidate_spec(_extract_json(((out.get("message") or {}).get("content") or "")), focus, parent)


def _save(spec: agents.AgentSpec, parent: agents.AgentSpec, score: float):
    db.ex("""INSERT INTO agent_profiles(key,name,mission,vendors_json,reasoning,web_search,task_type,parent_key,generation,score,status,created,updated)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (spec.key, spec.name, spec.mission, json.dumps(list(spec.vendors)), int(spec.reasoning), int(spec.web_search),
           spec.task_type, parent.key, spec.generation, score, "active", db.now(), db.now()))
    rows = db.q("SELECT id FROM agent_profiles WHERE status='active' ORDER BY score DESC,generation DESC,id DESC")
    for row in rows[config.UPGRADE_MAX_CHILDREN:]:
        db.ex("UPDATE agent_profiles SET status='archived',updated=? WHERE id=?", (db.now(), row["id"]))


async def run_cycle(focus: str = "auto", manual: bool = False) -> str:
    if LAST["running"]:
        return "Upgrade läuft bereits."
    LAST["running"] = True
    started = time.time()
    try:
        focus = _next_focus() if focus not in FOCI else focus
        parent = _parent(focus)
        rows = await model_pool.catalog()
        free_only = config.UPGRADE_FREE_ONLY and not manual
        factory = model_pool.best(rows, free_only=free_only, mode="deep", require_reasoning=True) or model_pool.best(rows, free_only=free_only, mode="deep")
        if not factory:
            msg = "Kein geeignetes kostenloses/lokales Modell für das automatische Upgrade verfügbar."
            LAST.update(ts=started, status=msg, focus=focus, score=0, candidate="")
            db.ex("INSERT INTO upgrade_runs(ts,focus,status,details) VALUES(?,?,?,?)", (started, focus, "skipped", msg))
            return msg
        judge = model_pool.best(rows, free_only=free_only, mode="deep", require_reasoning=True,
                                exclude={(str(factory.get("source")), str(factory.get("id")))}) or factory
        candidate = await _propose(parent, focus, factory)
        tasks = BENCH[focus][:config.UPGRADE_BENCH_TASKS]
        wins = ties = losses = 0
        notes = []
        parent_ms = child_ms = 0

        async def timed(spec, task):
            started_answer = time.perf_counter()
            text = await _answer(spec, task, factory)
            return text, int((time.perf_counter() - started_answer) * 1000)

        for i, task in enumerate(tasks):
            (parent_text, p_ms), (child_text, c_ms) = await asyncio.gather(timed(parent, task), timed(candidate, task))
            parent_ms += p_ms; child_ms += c_ms
            # alternate sides to reduce position bias
            if i % 2:
                winner = await _judge(task, child_text, parent_text, judge)
                child_winner = "A" if winner == "A" else "B" if winner == "B" else "TIE"
            else:
                winner = await _judge(task, parent_text, child_text, judge)
                child_winner = "B" if winner == "B" else "A" if winner == "A" else "TIE"
            if (i % 2 == 0 and winner == "B") or (i % 2 == 1 and winner == "A"):
                wins += 1; notes.append("win")
            elif winner == "TIE":
                ties += 1; notes.append("tie")
            else:
                losses += 1; notes.append("loss")
        score = round((wins + 0.5 * ties) / max(1, len(tasks)) * 100, 1)
        # A small quality gain is not worth a massive slowdown. A clearly better (>=75)
        # candidate may spend more compute; otherwise cap regression at ~35%.
        speed_ratio = child_ms / max(1, parent_ms)
        promote = score >= 60 and wins >= losses and (speed_ratio <= 1.35 or score >= 75)
        status = "promoted" if promote else "rejected"
        if promote:
            _save(candidate, parent, score)
        detail = (f"{candidate.name}: {wins} win / {ties} tie / {losses} loss gegen {parent.name}; "
                  f"Benchmark {score:.1f}; Zeit {child_ms} ms vs. {parent_ms} ms ({speed_ratio:.2f}x)")
        db.ex("INSERT INTO upgrade_runs(ts,focus,status,candidate_key,score,details) VALUES(?,?,?,?,?,?)",
              (started, focus, status, candidate.key, score, detail))
        db.set_setting("upgrade_last_ts", str(started))
        db.log_action("agent_upgrade", f"{status}: {detail}")
        LAST.update(ts=started, status=status, focus=focus, score=score, candidate=candidate.name)
        return ("✅ Neuer Child-Agent aktiviert: " if promote else "🧪 Candidate nicht besser genug: ") + detail
    except Exception as exc:
        msg = f"Upgrade fehlgeschlagen: {str(exc)[:300]}"
        LAST.update(ts=started, status=msg, focus=focus, score=0, candidate="")
        db.ex("INSERT INTO upgrade_runs(ts,focus,status,details) VALUES(?,?,?,?)", (started, focus, "error", msg))
        return msg
    finally:
        LAST["running"] = False


async def loop():
    # Do not compete with startup/model loading.
    await asyncio.sleep(300)
    while True:
        try:
            if config.UPGRADE_AUTO:
                last = float(db.get_setting("upgrade_last_ts", "0") or 0)
                if time.time() - last >= config.UPGRADE_INTERVAL_HOURS * 3600:
                    await run_cycle()
        except Exception:
            pass
        await asyncio.sleep(1800)


def status() -> dict:
    last = db.one("SELECT * FROM upgrade_runs ORDER BY id DESC LIMIT 1") or {}
    return {
        "auto": bool(config.UPGRADE_AUTO),
        "free_only": bool(config.UPGRADE_FREE_ONLY),
        "interval_hours": config.UPGRADE_INTERVAL_HOURS,
        "children": (db.one("SELECT COUNT(*) c FROM agent_profiles WHERE status='active'") or {"c": 0})["c"],
        "last": last,
        "running": bool(LAST["running"]),
    }
