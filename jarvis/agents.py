"""Multi-agent council for JARVIS.

Specialist agents are advisory only. They never receive Jarvis' side-effect tools;
the master Jarvis remains the only component allowed to act on the PC, files,
missions, payments or external accounts.
"""
import asyncio
import json
import re
import time
from dataclasses import dataclass

from . import config, db, model_pool


@dataclass(frozen=True)
class AgentSpec:
    key: str
    name: str
    mission: str
    vendors: tuple[str, ...]
    reasoning: bool = True
    web_search: bool = False
    task_type: str = "general"
    generation: int = 0


SPECS = {
    "strategist": AgentSpec(
        "strategist", "STRATEGIST",
        "Zerlege das Ziel in einen belastbaren Plan. Suche Hebel, Abhängigkeiten, Reihenfolge und Erfolgskriterien.",
        ("openai", "anthropic", "minimax", "z-ai"),
    ),
    "researcher": AgentSpec(
        "researcher", "RESEARCHER",
        "Prüfe Fakten, aktuelle Informationen, Alternativen und unbekannte Annahmen. Nenne Unsicherheiten explizit.",
        ("google", "qwen", "anthropic", "openai"), web_search=True,
    ),
    "engineer": AgentSpec(
        "engineer", "ENGINEER",
        "Entwirf die technisch robusteste Umsetzung. Achte auf Architektur, Tests, Fehlerfälle, Wartbarkeit und Performance.",
        ("z-ai", "x-ai", "moonshotai", "openai", "anthropic"),
    ),
    "analyst": AgentSpec(
        "analyst", "ANALYST",
        "Analysiere Optionen, Zahlen, Trade-offs, Engpässe und Messgrößen. Vermeide Bauchgefühl ohne Beleg.",
        ("deepseek", "google", "openai", "z-ai"),
    ),
    "critic": AgentSpec(
        "critic", "CRITIC",
        "Versuche den vorgeschlagenen Ansatz zu widerlegen. Finde blinde Flecken, falsche Annahmen und bessere Alternativen.",
        ("anthropic", "deepseek", "openai", "minimax"),
    ),
    "security": AgentSpec(
        "security", "SECURITY",
        "Prüfe Sicherheit, Datenschutz, Rechte, Secrets, Missbrauchsrisiken und irreversible Nebenwirkungen.",
        ("anthropic", "deepseek", "z-ai", "openai"),
    ),
    "creative": AgentSpec(
        "creative", "CREATIVE",
        "Suche unkonventionelle, aber realistische Lösungswege und Vereinfachungen, die die anderen Agenten übersehen könnten.",
        ("qwen", "minimax", "google", "moonshotai"),
    ),
    "auditor": AgentSpec(
        "auditor", "AUDITOR",
        "Definiere eine Abschlussprüfung: Was muss verifiziert werden, damit Jarvis Erfolg wirklich behaupten darf?",
        ("anthropic", "openai", "z-ai", "deepseek"),
    ),
}


LAST_RUN = {
    "ts": 0.0,
    "used": False,
    "task_type": "",
    "agents": [],
    "duration_ms": 0,
    "errors": 0,
}


_COMPLEX = re.compile(
    r"\b(baue|bau|entwickl|implement|reparier|debug|analys|strategie|plan|architektur|"
    r"vergleich|recherch|prüf|optimier|automatis|geschäft|business|vertrag|website|app|"
    r"system|agent|github|code|datenbank|sicherheit|security|deploy|integration)\w*\b",
    re.IGNORECASE,
)
_CODE = re.compile(r"\b(code|github|python|javascript|typescript|next\.?js|api|bug|debug|deploy|datenbank|sql|repo|app|website)\b", re.I)
_RESEARCH = re.compile(r"\b(aktuell|online|internet|recherch|finde|suche|markt|wettbewerb|vergleich|quelle|neueste)\w*\b", re.I)
_BUSINESS = re.compile(r"\b(business|umsatz|vertrieb|kunde|lead|strategie|preis|angebot|markt|unternehmen)\w*\b", re.I)
_RISK = re.compile(r"\b(sicherheit|security|secret|api.?key|passwort|recht|vertrag|zahlung|konto|admin|auth|daten|privacy)\w*\b", re.I)


def _has_agent_source() -> bool:
    return bool(
        (config.CLOUD_ENABLED and config.AGENT_USE_XKIRO and config.XKIRO_API_KEY)
        or (config.CLOUD_ENABLED and config.AGENT_USE_HF and config.HF_TOKEN)
        or config.AGENT_USE_OLLAMA
    )


def should_use_council(text: str) -> bool:
    if not config.AGENTS_ENABLED or config.AGENT_MODE == "off":
        return False
    if not _has_agent_source():
        return False
    if config.AGENT_MODE == "always":
        return True
    text = (text or "").strip()
    if len(text) >= 220:
        return True
    return bool(_COMPLEX.search(text))


def mission_review_due(cycles: int) -> bool:
    """Use the council on the first mission cycle and periodically afterwards."""
    return bool(config.AGENTS_ENABLED and int(cycles or 0) % config.AGENT_MISSION_EVERY == 0)


def task_type(text: str) -> str:
    if _CODE.search(text):
        return "code"
    if _BUSINESS.search(text):
        return "business"
    if _RESEARCH.search(text):
        return "research"
    return "general"


def custom_specs() -> dict[str, AgentSpec]:
    out = {}
    for row in db.q("SELECT * FROM agent_profiles WHERE status='active' ORDER BY score DESC, generation DESC, id DESC"):
        try:
            vendors = tuple(json.loads(row.get("vendors_json") or "[]"))
        except Exception:
            vendors = ()
        out[row["key"]] = AgentSpec(
            row["key"], row.get("name") or row["key"].upper(), row.get("mission") or "",
            vendors or ("openai", "anthropic", "google", "qwen", "deepseek", "z-ai"),
            bool(row.get("reasoning", 1)), bool(row.get("web_search", 0)),
            row.get("task_type") or "general", int(row.get("generation") or 1),
        )
    return out


def all_specs() -> dict[str, AgentSpec]:
    return {**SPECS, **custom_specs()}


def choose_roles(text: str) -> list[str]:
    """Pick complementary roles without wasting calls on every simple task."""
    roles = ["strategist", "critic"]
    if _CODE.search(text):
        roles += ["engineer", "security", "auditor"]
    elif _BUSINESS.search(text):
        roles += ["researcher", "analyst", "creative"]
    elif _RESEARCH.search(text):
        roles += ["researcher", "analyst", "auditor"]
    else:
        roles += ["analyst", "creative"]
    if _RISK.search(text) and "security" not in roles:
        roles.append("security")
    # Evolved child agents compete for one council seat in their specialty.
    kind = task_type(text)
    evolved = [r for r in db.q(
        "SELECT key FROM agent_profiles WHERE status='active' AND task_type IN (?, 'general') ORDER BY score DESC, generation DESC LIMIT 1",
        (kind,)) if r.get("key")]
    if evolved:
        roles.insert(max(1, len(roles) - 1), evolved[0]["key"])
    unique = list(dict.fromkeys(roles))
    return unique[:config.AGENT_MAX_AGENTS]


def _vendor(model_id: str, row: dict) -> str:
    return str(row.get("owned_by") or model_id.split("/", 1)[0]).lower()


def _accessible(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        tier = str(row.get("access_tier") or "paid").lower()
        if tier == "premium" and not config.AGENT_ALLOW_PREMIUM:
            continue
        out.append(row)
    return out


def rank_models(spec: AgentSpec, rows: list[dict], used: set[tuple[str, str]] | None = None) -> list[dict]:
    """Rank live-catalog models for one specialist. Never invent model IDs."""
    used = used or set()
    rows = _accessible(rows)
    ranked = []
    for row in rows:
        mid = str(row.get("id") or "")
        if not mid:
            continue
        caps = row.get("capabilities") or {}
        vendor = _vendor(mid, row)
        try:
            vendor_rank = spec.vendors.index(vendor)
        except ValueError:
            vendor_rank = len(spec.vendors) + 2

        tier = str(row.get("access_tier") or "paid").lower()
        source = str(row.get("source") or "")
        key = (source, mid)
        score = 1000 - vendor_rank * 120
        score += int(model_pool.reliability(source, mid) * 120)
        avg_ms = model_pool.average_latency_ms(source, mid)
        if avg_ms > 0:
            score -= min(int(avg_ms / 120), 80)
        if spec.reasoning and caps.get("reasoning"):
            score += 90
        if caps.get("tools"):
            score += 20
        if caps.get("vision"):
            score += 5
        if config.AGENT_PREFER_FREE and tier in ("free", "local"):
            score += 260
        elif config.AGENT_PREFER_FREE and tier not in ("free", "local"):
            score -= 80
        if tier == "local":
            score += 40
        if key in used:
            score -= 500  # diversity: distinct source/model if possible
        ctx = int(row.get("context_length") or 0)
        score += min(ctx // 10000, 30)
        ranked.append((score, mid, row))
    ranked.sort(key=lambda x: (-x[0], x[1]))
    return [row for _, _, row in ranked]


def _effort(row: dict, preferred: str = "high") -> str:
    levels = ((row.get("reasoning_efforts") or {}).get("levels") or [])
    if not levels:
        return ""
    for level in (preferred, "high", "medium", "low", "max", "xhigh"):
        if level in levels:
            return level
    return str(levels[0]) if levels else ""


def _prompt(spec: AgentSpec, task: str, peer_context: str = "") -> list[dict]:
    system = (
        f"Du bist JARVIS-{spec.name}, ein spezialisierter beratender Agent in einem Multi-Agenten-System. "
        "Du führst KEINE externen Aktionen aus und behauptest keine Ausführung. "
        "Widersprich falschen Annahmen und liefere kompakte, konkrete Hinweise. "
        f"DEINE ROLLE: {spec.mission}\n"
        "Antworte auf Deutsch in vier kurzen Abschnitten: BEFUND, VORSCHLAG, RISIKEN, PRÜFUNG."
    )
    user = task[:12000]
    if peer_context:
        user += (
            "\n\nANDERE AGENTEN HABEN BEREITS FOLGENDES GELIEFERT:\n"
            + peer_context[:14000]
            + "\n\nPrüfe diese Aussagen gegeneinander. Markiere Widersprüche, unbelegte Behauptungen und den robustesten gemeinsamen Kern."
        )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def _run_one(spec: AgentSpec, task: str, candidates: list[dict], peer_context: str = "") -> dict:
    errors = []
    # Try a few live-catalog candidates: one inaccessible model must not kill the council.
    for row in candidates[:config.AGENT_MODEL_FALLBACKS]:
        model = str(row.get("id") or "")
        if not model:
            continue
        try:
            resp = await model_pool.call(
                row, _prompt(spec, task, peer_context),
                max_tokens=config.AGENT_MAX_TOKENS,
                reasoning_effort=_effort(row),
                web_search=spec.web_search and str(row.get("source")) == "xkiro",
            )
            text = ((resp.get("message") or {}).get("content") or "").strip()
            if text:
                return {"key": spec.key, "name": spec.name, "model": model,
                        "source": row.get("source", ""), "text": text, "ok": True}
        except Exception as exc:
            errors.append(f"{model}: {str(exc)[:160]}")
    return {
        "key": spec.key, "name": spec.name,
        "model": candidates[0].get("id") if candidates else "",
        "source": candidates[0].get("source") if candidates else "",
        "text": "", "ok": False,
        "error": " | ".join(errors[-2:]) or "Kein passendes Modell im Live-Katalog.",
    }


async def council(task: str) -> str:
    """Run a bounded specialist council and return context for the master Jarvis."""
    started = time.perf_counter()
    from . import privacy
    # Privatsphäre: Spezialisten (externe Cloud-Modelle) bekommen nie private Inhalte
    if config.PRIVACY == "strikt" or privacy.sensitive_findings(task):
        LAST_RUN.update(ts=time.time(), used=False, task_type=task_type(task), agents=[], duration_ms=0, errors=0)
        return ""
    if not should_use_council(task):
        LAST_RUN.update(ts=time.time(), used=False, task_type=task_type(task), agents=[], duration_ms=0, errors=0)
        return ""

    try:
        rows = await model_pool.catalog()
    except Exception as exc:
        LAST_RUN.update(ts=time.time(), used=False, task_type=task_type(task),
                        agents=[{"name": "CATALOG", "ok": False, "error": str(exc)[:180]}],
                        duration_ms=int((time.perf_counter() - started) * 1000), errors=1)
        return ""

    roles = choose_roles(task)
    specs = all_specs()
    used: set[tuple[str, str]] = set()
    jobs = []
    for role in roles:
        spec = specs.get(role)
        if not spec:
            continue
        candidates = rank_models(spec, rows, used)
        if candidates:
            used.add((str(candidates[0].get("source") or ""), str(candidates[0].get("id") or "")))
        jobs.append((spec, candidates))

    sem = asyncio.Semaphore(config.AGENT_MAX_PARALLEL)

    async def guarded(spec, candidates, peer_context=""):
        async with sem:
            return await _run_one(spec, task, candidates, peer_context)

    # Round 1: independent specialists. Round 2: Critic/Auditor read their peers
    # and explicitly cross-check contradictions before the master sees the council.
    reviewers = {"critic", "auditor"}
    first_jobs = [(spec, candidates) for spec, candidates in jobs if spec.key not in reviewers]
    review_jobs = [(spec, candidates) for spec, candidates in jobs if spec.key in reviewers]
    first_results = await asyncio.gather(*(guarded(spec, candidates) for spec, candidates in first_jobs))
    peer_context = "\n\n".join(
        f"{r.get('name')} ({r.get('model')}):\n{r.get('text')}"
        for r in first_results if r.get("ok")
    )
    review_results = await asyncio.gather(
        *(guarded(spec, candidates, peer_context) for spec, candidates in review_jobs)
    ) if review_jobs else []
    results = list(first_results) + list(review_results)
    good = [r for r in results if r.get("ok")]
    errors = len(results) - len(good)
    LAST_RUN.update(
        ts=time.time(), used=bool(good), task_type=task_type(task),
        agents=[{k: r.get(k) for k in ("key", "name", "source", "model", "ok", "error")} for r in results],
        duration_ms=int((time.perf_counter() - started) * 1000), errors=errors,
    )
    if not good:
        return ""

    blocks = []
    for r in good:
        blocks.append(f"### {r['name']} · {r.get('source','?')} · {r['model']}\n{r['text']}")
    return (
        "MULTI-AGENTENRAT (nur Beratung, nicht als ausgeführte Handlung behandeln):\n"
        + "\n\n".join(blocks)
        + "\n\nMASTER-REGEL: Prüfe Widersprüche selbst. Nutze nur belastbare Hinweise und führe Aktionen ausschließlich über deine eigenen Jarvis-Werkzeuge aus."
    )


def public_state() -> dict:
    return {
        "enabled": bool(config.AGENTS_ENABLED),
        "mode": config.AGENT_MODE,
        "max_agents": config.AGENT_MAX_AGENTS,
        "mission_every": config.AGENT_MISSION_EVERY,
        "prefer_free": bool(config.AGENT_PREFER_FREE),
        "allow_premium": bool(config.AGENT_ALLOW_PREMIUM),
        "sources": {"xkiro": bool(config.XKIRO_API_KEY and config.CLOUD_ENABLED and config.AGENT_USE_XKIRO),
                    "huggingface": bool(config.HF_TOKEN and config.CLOUD_ENABLED and config.AGENT_USE_HF),
                    "ollama": bool(config.AGENT_USE_OLLAMA)},
        "roles": [{"key": x.key, "name": x.name, "generation": x.generation}
                  for x in all_specs().values()],
        "custom_agents": len(custom_specs()),
        "last": dict(LAST_RUN),
    }
