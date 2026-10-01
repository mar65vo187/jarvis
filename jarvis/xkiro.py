"""xKiro OpenAI-compatible provider for JARVIS.

Keeps the provider boundary small: the rest of Jarvis sees the same message/tool
shape that the Ollama path already uses. API keys never leave request headers
and are never included in diagnostics.
"""
import asyncio
import json
import time

import httpx

from . import config, db
from .errors import CloudConfigError, CloudUnavailable

_lock = asyncio.Semaphore(4)
_catalog_cache: list[dict] = []
_catalog_checked = 0.0


def _headers() -> dict:
    if not config.XKIRO_API_KEY:
        raise CloudConfigError("xKiro braucht einen API-Schlüssel. In EINSTELLUNGEN eintragen.")
    return {"Authorization": f"Bearer {config.XKIRO_API_KEY}", "Content-Type": "application/json"}


def _clean_error(response: httpx.Response) -> str:
    try:
        data = response.json()
        err = data.get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            message = err.get("message") or err.get("type") or ""
        else:
            message = str(err or "")
    except (ValueError, AttributeError):
        message = ""
    if config.XKIRO_API_KEY:
        message = str(message).replace(config.XKIRO_API_KEY, "[Schlüssel]")
    if response.status_code == 401:
        return "xKiro-Zugang ungültig. API-Schlüssel in EINSTELLUNGEN prüfen."
    if response.status_code == 402:
        return "xKiro-Guthaben bzw. Nutzungslimit reicht für diese Anfrage nicht aus."
    if response.status_code == 404:
        return f"xKiro-Modell '{config.XKIRO_MODEL}' wurde nicht gefunden. Modell-ID inklusive Anbieterpräfix prüfen."
    if response.status_code == 429:
        return "xKiro-Anfragelimit erreicht. Bitte später erneut versuchen."
    return f"xKiro API {response.status_code}: {message[:300] or 'Anfrage fehlgeschlagen.'}"


def _content(message: dict):
    text = message.get("content")
    images = message.get("images") or []
    if not images:
        return "" if text is None else str(text)
    parts = []
    if text:
        parts.append({"type": "text", "text": str(text)})
    media = message.get("image_media_type", "image/jpeg")
    for data in images:
        parts.append({"type": "image_url", "image_url": {"url": f"data:{media};base64,{data}"}})
    return parts


def openai_messages(messages: list[dict]) -> list[dict]:
    """Convert Jarvis' common history format into OpenAI Chat Completions."""
    out = []
    for m in messages:
        role = m.get("role")
        if role not in ("system", "user", "assistant", "tool"):
            continue
        if role == "tool":
            item = {
                "role": "tool",
                "tool_call_id": m.get("tool_call_id") or "",
                "content": str(m.get("content") or "(leer)"),
            }
        else:
            item = {"role": role, "content": _content(m)}
            calls = m.get("tool_calls") or []
            if role == "assistant" and calls:
                normalized = []
                for n, call in enumerate(calls):
                    fn = (call or {}).get("function") or {}
                    args = fn.get("arguments") or {}
                    if not isinstance(args, str):
                        args = json.dumps(args, ensure_ascii=False)
                    normalized.append({
                        "id": call.get("id") or f"call_{len(out)}_{n}",
                        "type": "function",
                        "function": {"name": fn.get("name", ""), "arguments": args},
                    })
                item["tool_calls"] = normalized
                if not item["content"]:
                    item["content"] = None
        out.append(item)
    return out


def _text_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(str(p.get("text", "")))
        return "\n".join(parts)
    return ""


async def list_model_details(force: bool = False) -> list[dict]:
    """Live xKiro catalog including vendor, access tier, price and capabilities."""
    global _catalog_cache, _catalog_checked
    if not force and _catalog_cache and time.time() - _catalog_checked < 300:
        return [dict(row) for row in _catalog_cache]
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(f"{config.XKIRO_BASE_URL}/models")
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(f"xKiro-Modellkatalog nicht erreichbar: {exc}") from None
    rows = data.get("data", []) if isinstance(data, dict) else data if isinstance(data, list) else []
    normalized = []
    for row in rows:
        if isinstance(row, dict) and row.get("id"):
            normalized.append(dict(row))
        elif isinstance(row, str):
            normalized.append({"id": row, "owned_by": row.split("/", 1)[0]})
    _catalog_cache = normalized
    _catalog_checked = time.time()
    return [dict(row) for row in normalized]


async def list_models() -> list[str]:
    """Public xKiro chat-model IDs; details are retained for agent routing."""
    rows = await list_model_details()
    return sorted({str(row.get("id")) for row in rows if row.get("id")})


async def check() -> dict:
    status = config.XKIRO_STATUS
    status.update(checked=time.time(), ok=False, model_ok=False)
    if not config.CLOUD_ENABLED:
        status["msg"] = "Cloud-KI ist gesperrt; Jarvis nutzt lokal Ollama."
        return status
    if not config.XKIRO_API_KEY:
        status["msg"] = "xKiro-API-Schlüssel fehlt – in EINSTELLUNGEN eintragen."
        return status
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            usage = await client.get(f"{config.XKIRO_BASE_URL}/usage", headers=_headers())
            if usage.status_code >= 400:
                status["msg"] = _clean_error(usage)
                return status
            models = await client.get(f"{config.XKIRO_BASE_URL}/models")
            if models.status_code >= 400:
                status["msg"] = _clean_error(models)
                return status
            data = models.json()
            rows = data.get("data", []) if isinstance(data, dict) else data if isinstance(data, list) else []
            ids = {str(x.get("id")) for x in rows if isinstance(x, dict) and x.get("id")}
            model_ok = config.XKIRO_MODEL in ids if ids else True
            usage_data = usage.json() if usage.content else {}
            free = (usage_data or {}).get("free_tokens") or {}
            wallet = (usage_data or {}).get("wallet") or {}
            detail = []
            if free.get("remaining") is not None:
                detail.append(f"Free-Tokens übrig: {free.get('remaining')}")
            if wallet.get("balance_usd") is not None:
                detail.append(f"Wallet USD {wallet.get('balance_usd')}")
            status.update(ok=True, model_ok=model_ok,
                          msg=("bereit" if model_ok else f"Modell {config.XKIRO_MODEL} fehlt im xKiro-Katalog"),
                          usage=" · ".join(detail))
    except (httpx.HTTPError, ValueError):
        status["msg"] = "xKiro nicht erreichbar. Internetverbindung prüfen."
    return status


async def call(messages, tools=None, max_tokens=None, model=None, reasoning_effort=None, web_search=False):
    if not config.CLOUD_ENABLED:
        raise RuntimeError("Cloud-KI ist gesperrt. In EINSTELLUNGEN aktivieren oder Ollama verwenden.")
    headers = _headers()
    payload = {
        "model": model or config.XKIRO_MODEL,
        "messages": openai_messages(messages),
        "stream": False,
        "max_tokens": max_tokens or config.XKIRO_MAX_TOKENS,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    effort = config.XKIRO_REASONING_EFFORT if reasoning_effort is None else reasoning_effort
    if effort:
        payload["reasoning_effort"] = effort
    if web_search:
        payload["web_search"] = {"enable": True, "count": 5}

    async with _lock:
        delay = 1.0
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.XKIRO_TIMEOUT_SEC, connect=10)) as client:
            for attempt in range(3):
                try:
                    response = await client.post(f"{config.XKIRO_BASE_URL}/chat/completions",
                                                 headers=headers, json=payload)
                except httpx.ConnectError:
                    if attempt < 2:
                        await asyncio.sleep(delay)
                        delay *= 2
                        continue
                    raise CloudUnavailable("xKiro ist nicht erreichbar. Internetverbindung prüfen.") from None
                except httpx.HTTPError:
                    raise CloudUnavailable("xKiro-Anfrage unterbrochen oder Zeitlimit erreicht. Bitte erneut versuchen.") from None
                if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                if response.status_code in (401, 403, 404):
                    raise CloudConfigError(_clean_error(response))
                if response.status_code in (402, 429) or response.status_code >= 500:
                    raise CloudUnavailable(_clean_error(response))
                if response.status_code >= 400:
                    raise RuntimeError(_clean_error(response))
                try:
                    data = response.json()
                    choice = data["choices"][0]
                    msg = choice["message"]
                except (ValueError, KeyError, IndexError, TypeError):
                    raise RuntimeError("xKiro hat eine ungültige Antwort geliefert.") from None

                calls = msg.get("tool_calls") or []
                if choice.get("finish_reason") == "length" and calls:
                    raise RuntimeError("xKiro-Ausgabelimit erreicht; unvollständige Werkzeugaufrufe wurden nicht ausgeführt.")
                normalized = []
                for n, call in enumerate(calls):
                    fn = (call or {}).get("function") or {}
                    args = fn.get("arguments") or "{}"
                    try:
                        parsed = json.loads(args) if isinstance(args, str) else args
                    except json.JSONDecodeError:
                        parsed = args
                    normalized.append({
                        "id": call.get("id") or f"call_{n}",
                        "function": {"name": fn.get("name", ""), "arguments": parsed},
                    })
                usage = data.get("usage") or {}
                db.add_usage(int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), 0, 0.0)
                text = _text_content(msg.get("content")).strip()
                if choice.get("finish_reason") == "length" and not calls:
                    text += "\n[Antwort durch Ausgabelimit gekürzt.]"
                config.XKIRO_STATUS.update(ok=True, model_ok=True, msg="bereit", checked=time.time())
                return {"message": {"content": text, "tool_calls": normalized}}
    raise RuntimeError("xKiro-Anfrage fehlgeschlagen.")
