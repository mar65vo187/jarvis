"""Hugging Face Inference Providers via the OpenAI-compatible router."""
import asyncio
import json
import time
import httpx

from . import config, db, xkiro
from .errors import CloudConfigError, CloudUnavailable

_lock = asyncio.Semaphore(4)
_catalog_cache: list[dict] = []
_catalog_checked = 0.0


def _headers() -> dict:
    if not config.HF_TOKEN:
        raise CloudConfigError("Hugging-Face-Token fehlt. In EINSTELLUNGEN eintragen.")
    return {"Authorization": f"Bearer {config.HF_TOKEN}", "Content-Type": "application/json"}


def _clean_error(r: httpx.Response) -> str:
    try:
        data = r.json()
        err = data.get("error") if isinstance(data, dict) else None
        msg = err.get("message", "") if isinstance(err, dict) else str(err or data)
    except Exception:
        msg = r.text[:240]
    if config.HF_TOKEN:
        msg = msg.replace(config.HF_TOKEN, "[Token]")
    if r.status_code == 401:
        return "Hugging-Face-Token ungültig oder ohne Inference-Providers-Berechtigung."
    if r.status_code == 402:
        return "Hugging-Face-Inference-Guthaben reicht für diese Anfrage nicht aus."
    if r.status_code == 429:
        return "Hugging-Face-Anfragelimit erreicht."
    return f"Hugging Face API {r.status_code}: {msg[:300]}"


async def list_model_details(force: bool = False) -> list[dict]:
    global _catalog_cache, _catalog_checked
    if not force and _catalog_cache and time.time() - _catalog_checked < 300:
        return [dict(x) for x in _catalog_cache]
    headers = _headers()
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{config.HF_BASE_URL}/models", headers=headers)
            if r.status_code in (401, 403, 404):
                raise CloudConfigError(_clean_error(r))
            if r.status_code in (402, 429) or r.status_code >= 500:
                raise CloudUnavailable(_clean_error(r))
            if r.status_code >= 400:
                raise RuntimeError(_clean_error(r))
            data = r.json()
    except httpx.HTTPError as exc:
        raise CloudUnavailable(f"Hugging Face nicht erreichbar: {exc}") from None
    rows = data.get("data", []) if isinstance(data, dict) else []
    out = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        providers = [p for p in (row.get("providers") or []) if isinstance(p, dict) and p.get("status", "live") == "live"]
        ctx = max([int(p.get("context_length") or 0) for p in providers] or [int(row.get("context_length") or 0)])
        tools = any(bool(p.get("supports_tools")) for p in providers)
        prices = [p.get("pricing") or {} for p in providers]
        input_prices = [float(p.get("input") or 0) for p in prices if p.get("input") is not None]
        output_prices = [float(p.get("output") or 0) for p in prices if p.get("output") is not None]
        out.append({
            **row,
            "id": str(row["id"]),
            "owned_by": str(row.get("owned_by") or str(row["id"]).split("/", 1)[0]),
            "context_length": ctx,
            "access_tier": "metered",
            "capabilities": {
                "reasoning": "reason" in str(row.get("id", "")).lower() or "gpt-oss" in str(row.get("id", "")).lower(),
                "tools": tools,
                "vision": "image" in ((row.get("architecture") or {}).get("input_modalities") or []),
            },
            "pricing": {
                "input": min(input_prices) if input_prices else None,
                "output": min(output_prices) if output_prices else None,
            },
        })
    _catalog_cache, _catalog_checked = out, time.time()
    return [dict(x) for x in out]


async def list_models() -> list[str]:
    return sorted({str(x["id"]) for x in await list_model_details() if x.get("id")})


def _model(model: str | None) -> str:
    model = model or config.HF_MODEL
    if ":" in model:
        return model
    return f"{model}:{config.HF_POLICY}" if config.HF_POLICY else model


async def check() -> dict:
    st = config.HF_STATUS
    st.update(checked=time.time(), ok=False, model_ok=False)
    if not config.CLOUD_ENABLED:
        st["msg"] = "Cloud-KI ist gesperrt."
        return st
    if not config.HF_TOKEN:
        st["msg"] = "Hugging-Face-Token fehlt."
        return st
    try:
        ids = await list_models()
        base = config.HF_MODEL.split(":", 1)[0]
        st.update(ok=True, model_ok=(base in ids), msg="bereit" if base in ids else f"Modell {base} fehlt im HF-Katalog")
    except Exception as exc:
        st["msg"] = str(exc)[:300]
    return st


async def call(messages, tools=None, max_tokens=None, model=None, reasoning_effort=None):
    if not config.CLOUD_ENABLED:
        raise RuntimeError("Cloud-KI ist gesperrt.")
    payload = {
        "model": _model(model),
        "messages": xkiro.openai_messages(messages),
        "stream": False,
        "max_tokens": max_tokens or config.HF_MAX_TOKENS,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    async with _lock:
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.HF_TIMEOUT_SEC, connect=10)) as c:
            try:
                r = await c.post(f"{config.HF_BASE_URL}/chat/completions", headers=_headers(), json=payload)
            except httpx.HTTPError:
                raise CloudUnavailable("Hugging Face nicht erreichbar oder Anfrage abgebrochen.") from None
            if r.status_code in (401, 403, 404):
                raise CloudConfigError(_clean_error(r))
            if r.status_code in (402, 429) or r.status_code >= 500:
                raise CloudUnavailable(_clean_error(r))
            if r.status_code >= 400:
                raise RuntimeError(_clean_error(r))
            try:
                data = r.json()
                choice = data["choices"][0]
                msg = choice["message"]
            except Exception:
                raise RuntimeError("Hugging Face hat eine ungültige Antwort geliefert.") from None
            calls = []
            for n, call in enumerate(msg.get("tool_calls") or []):
                fn = (call or {}).get("function") or {}
                args = fn.get("arguments") or "{}"
                try:
                    parsed = json.loads(args) if isinstance(args, str) else args
                except json.JSONDecodeError:
                    parsed = args
                calls.append({"id": call.get("id") or f"hf_{n}",
                              "function": {"name": fn.get("name", ""), "arguments": parsed}})
            usage = data.get("usage") or {}
            db.add_usage(int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), 0, 0.0)
            return {"message": {"content": xkiro._text_content(msg.get("content")).strip(), "tool_calls": calls}}
