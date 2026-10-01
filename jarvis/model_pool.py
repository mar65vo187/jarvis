"""Unified model pool: xKiro + Hugging Face + local Ollama."""
import asyncio
import time
from . import config, db, huggingface, local_llm, xkiro


async def _safe(source: str, coro):
    try:
        rows = await coro
        return [{**row, "source": source} for row in rows]
    except Exception:
        return []


async def catalog() -> list[dict]:
    jobs = []
    if config.CLOUD_ENABLED and config.AGENT_USE_XKIRO and config.XKIRO_API_KEY:
        jobs.append(_safe("xkiro", xkiro.list_model_details()))
    if config.CLOUD_ENABLED and config.AGENT_USE_HF and config.HF_TOKEN:
        jobs.append(_safe("huggingface", huggingface.list_model_details()))
    if config.AGENT_USE_OLLAMA:
        jobs.append(_safe("ollama", local_llm.list_model_details()))
    if not jobs:
        return []
    groups = await asyncio.gather(*jobs)
    rows = [row for group in groups for row in group]
    # de-duplicate exact source/model pairs
    seen, out = set(), []
    for row in rows:
        key = (row.get("source"), row.get("id"))
        if key in seen:
            continue
        seen.add(key); out.append(row)
    return out


def reliability(source: str, model: str) -> float:
    r = db.one("SELECT successes,failures,total_latency_ms FROM model_metrics WHERE source=? AND model=?",
               (source, model))
    if not r:
        return 0.5
    total = int(r["successes"] or 0) + int(r["failures"] or 0)
    return (int(r["successes"] or 0) + 1) / (total + 2)


def record(source: str, model: str, ok: bool, latency_ms: int):
    db.ex("INSERT OR IGNORE INTO model_metrics(source,model) VALUES(?,?)", (source, model))
    db.ex("UPDATE model_metrics SET successes=successes+?, failures=failures+?, total_latency_ms=total_latency_ms+?, last_used=? WHERE source=? AND model=?",
          (1 if ok else 0, 0 if ok else 1, max(0, int(latency_ms)), time.time(), source, model))


async def call(row: dict, messages: list[dict], max_tokens: int, reasoning_effort: str = "", web_search: bool = False):
    source, model = str(row.get("source") or ""), str(row.get("id") or "")
    started = time.perf_counter()
    try:
        if source == "xkiro":
            result = await xkiro.call(messages, tools=None, max_tokens=max_tokens, model=model,
                                      reasoning_effort=reasoning_effort, web_search=web_search)
        elif source == "huggingface":
            result = await huggingface.call(messages, tools=None, max_tokens=max_tokens, model=model,
                                            reasoning_effort=reasoning_effort)
        elif source == "ollama":
            result = await local_llm.call(messages, max_tokens=max_tokens, model=model)
        else:
            raise RuntimeError(f"Unbekannte Modellquelle: {source}")
        record(source, model, True, int((time.perf_counter() - started) * 1000))
        return result
    except Exception:
        record(source, model, False, int((time.perf_counter() - started) * 1000))
        raise


def best(rows: list[dict], *, free_only: bool = False, exclude: set[tuple[str,str]] | None = None) -> dict | None:
    exclude = exclude or set()
    scored = []
    for row in rows:
        key = (str(row.get("source")), str(row.get("id")))
        if key in exclude:
            continue
        tier = str(row.get("access_tier") or "")
        if free_only and tier not in ("free", "local"):
            continue
        rel = reliability(*key)
        score = rel * 200
        if tier == "local": score += 160
        elif tier == "free": score += 120
        if (row.get("capabilities") or {}).get("reasoning"): score += 40
        if (row.get("capabilities") or {}).get("tools"): score += 10
        scored.append((score, key, row))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return scored[0][2] if scored else None
