"""Adaptive local inference policy for JARVIS.

Keeps simple requests fast and spends extra local compute only when the task is
actually complex.  The controller also learns from measured local model latency
and reliability; it never sends prompts or private data anywhere.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

from . import config, db


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    think: bool
    max_tokens: int
    target_ms: int


_DEEP = re.compile(
    r"\b(analys|architektur|debug|implement|entwickl|strategie|optimier|beweis|prüf|"
    r"vergleich|recherch|sicherheit|security|migration|datenbank|agent|github|deploy|"
    r"mehrstufig|ursache|trade.?off|benchmark|performance)\w*\b",
    re.I,
)
_FAST = re.compile(
    r"^\s*(hallo|hi|hey|danke|ok|okay|ja|nein|status|ping|wie spät|wie viel uhr|"
    r"guten morgen|guten abend)[!.?\s]*$",
    re.I,
)


def complexity(text: str) -> int:
    """Cheap deterministic complexity estimate. No model call = no routing delay."""
    text = (text or "").strip()
    if not text or _FAST.search(text):
        return 0
    score = 0
    n = len(text)
    if n >= 140:
        score += 1
    if n >= 420:
        score += 2
    if n >= 1200:
        score += 2
    deep_hits = len(_DEEP.findall(text))
    if deep_hits:
        score += min(5, 1 + deep_hits)
    if "```" in text or "Traceback" in text or "Exception" in text:
        score += 2
    if text.count("\n") >= 5:
        score += 1
    if text.count("?") >= 3:
        score += 1
    # Multiple explicit constraints usually need planning rather than raw speed.
    if len(re.findall(r"\b(und|aber|außerdem|danach|gleichzeitig|ohne|mit)\b", text, re.I)) >= 4:
        score += 1
    return min(score, 10)


def profile_text(text: str) -> RuntimeProfile:
    score = complexity(text)
    if score <= 1:
        return RuntimeProfile("fast", False, config.FAST_MAX_TOKENS, config.FAST_TARGET_MS)
    if score <= 4:
        return RuntimeProfile("balanced", False, config.BALANCED_MAX_TOKENS, config.BALANCED_TARGET_MS)
    return RuntimeProfile("deep", True, config.DEEP_MAX_TOKENS, config.DEEP_TARGET_MS)


def profile_messages(messages: list[dict]) -> RuntimeProfile:
    text = next((str(m.get("content") or "") for m in reversed(messages) if m.get("role") == "user"), "")
    # Strip the dynamic timestamp inserted by brain.think so it does not affect classification.
    text = re.sub(r"^\[Jetzt:[^\]]+\]\s*", "", text)
    return profile_text(text)


def model_for(profile: RuntimeProfile) -> str:
    if profile.name == "fast":
        return db.get_setting("runtime_fast_model", "") or config.FAST_MODEL or config.MODEL
    if profile.name == "deep":
        return db.get_setting("runtime_deep_model", "") or config.DEEP_MODEL or config.MODEL
    return config.MODEL


def should_think(profile: RuntimeProfile) -> bool:
    if config.THINK:  # explicit owner override: always think
        return True
    return bool(config.ADAPTIVE_THINK and profile.think)


def record(model: str, profile: RuntimeProfile, ok: bool, latency_ms: int):
    """Record only aggregate timing/success counters, never prompt contents."""
    db.ex("""INSERT OR IGNORE INTO runtime_metrics(profile,model) VALUES(?,?)""", (profile.name, model))
    db.ex("""UPDATE runtime_metrics SET calls=calls+1, successes=successes+?, failures=failures+?,
             total_latency_ms=total_latency_ms+?, last_used=? WHERE profile=? AND model=?""",
          (1 if ok else 0, 0 if ok else 1, max(0, int(latency_ms)), time.time(), profile.name, model))


def _row_stats(row: dict) -> tuple[float, float, int]:
    calls = max(0, int(row.get("calls") or 0))
    successes = max(0, int(row.get("successes") or 0))
    reliability = (successes + 1) / (calls + 2)
    avg_ms = float(row.get("total_latency_ms") or 0) / max(1, calls)
    return reliability, avg_ms, calls


def tune_from_history() -> dict:
    """Self-tune routing from real local runs without modifying program code.

    Fast route: pick the quickest model that has enough observations and >=80%
    smoothed reliability. Deep route: pick the most reliable observed deep model;
    latency is a tie-breaker. This changes only SQLite routing settings and is
    therefore reversible on the next tuning pass.
    """
    if not config.PERFORMANCE_TUNE:
        return status()
    rows = db.q("SELECT * FROM runtime_metrics WHERE calls>=3")
    fast = []
    deep = []
    for row in rows:
        rel, avg_ms, calls = _row_stats(row)
        if rel < 0.80:
            continue
        item = (row.get("model") or "", rel, avg_ms, calls)
        if row.get("profile") == "fast":
            fast.append(item)
        elif row.get("profile") == "deep":
            deep.append(item)
    if fast:
        best = sorted(fast, key=lambda x: (x[2], -x[1], x[0]))[0][0]
        if best:
            db.set_setting("runtime_fast_model", best)
    if deep:
        best = sorted(deep, key=lambda x: (-x[1], x[2], x[0]))[0][0]
        if best:
            db.set_setting("runtime_deep_model", best)
    db.set_setting("performance_last_tune", str(time.time()))
    return status()


async def loop():
    await __import__("asyncio").sleep(180)
    while True:
        try:
            tune_from_history()
        except Exception:
            pass
        await __import__("asyncio").sleep(max(300, config.PERFORMANCE_TUNE_INTERVAL_MIN * 60))


def status() -> dict:
    rows = db.q("SELECT * FROM runtime_metrics ORDER BY last_used DESC LIMIT 12")
    metrics = []
    for row in rows:
        rel, avg_ms, calls = _row_stats(row)
        metrics.append({
            "profile": row.get("profile") or "",
            "model": row.get("model") or "",
            "calls": calls,
            "reliability": round(rel, 3),
            "avg_latency_ms": int(avg_ms),
        })
    return {
        "adaptive_think": bool(config.ADAPTIVE_THINK),
        "auto_tune": bool(config.PERFORMANCE_TUNE),
        "fast_model": db.get_setting("runtime_fast_model", "") or config.FAST_MODEL or config.MODEL,
        "balanced_model": config.MODEL,
        "deep_model": db.get_setting("runtime_deep_model", "") or config.DEEP_MODEL or config.MODEL,
        "last_tune": float(db.get_setting("performance_last_tune", "0") or 0),
        "metrics": metrics,
    }
