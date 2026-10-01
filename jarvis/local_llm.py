"""Local Ollama access for advisory agents and model discovery."""
import time
import httpx
from . import config


async def list_model_details() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=4) as c:
            r = await c.get(f"{config.OLLAMA_BASE_URL}/api/tags")
            r.raise_for_status()
            rows = r.json().get("models", [])
    except Exception:
        return []
    out = []
    for row in rows:
        mid = str(row.get("name") or "")
        if not mid:
            continue
        low = mid.lower()
        out.append({
            "id": mid,
            "owned_by": mid.split(":", 1)[0].split("/", 1)[0],
            "access_tier": "local",
            "context_length": config.NUM_CTX,
            "capabilities": {
                "reasoning": any(x in low for x in ("qwen3", "deepseek", "reason")),
                "tools": True,
                "vision": any(x in low for x in ("vl", "vision", "llava")),
            },
            "pricing": {"input": 0.0, "output": 0.0},
        })
    return out


async def call(messages, max_tokens=None, model=None):
    payload = {
        "model": model or config.MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": config.KEEP_ALIVE,
        "options": {"num_predict": max_tokens or config.AGENT_MAX_TOKENS,
                    "temperature": config.TEMPERATURE, "num_ctx": config.NUM_CTX},
    }
    if not config.THINK:
        payload["think"] = False
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.OLLAMA_TIMEOUT_SEC, connect=4)) as c:
            r = await c.post(f"{config.OLLAMA_BASE_URL}/api/chat", json=payload)
    except httpx.HTTPError:
        raise RuntimeError("Lokales Ollama ist für den Agenten nicht erreichbar.") from None
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama API {r.status_code}: {r.text[:300]}")
    msg = (r.json().get("message") or {})
    return {"message": {"content": str(msg.get("content") or "").strip(), "tool_calls": []},
            "latency_ms": int((time.perf_counter() - started) * 1000)}
