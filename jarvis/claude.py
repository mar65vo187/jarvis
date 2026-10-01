"""Anthropic Messages API: native tool results, vision and bounded requests.

The API key never appears in the HUD, conversation, or tool definitions.
"""
import asyncio
import copy
import json
import time

import httpx

from . import config, db
from .errors import BudgetExceeded, CloudConfigError, CloudUnavailable  # noqa: F401

API_URL = "https://api.anthropic.com/v1"
_lock = asyncio.Lock()


def _headers():
    if not config.ANTHROPIC_API_KEY:
        raise CloudConfigError("Claude braucht einen Anthropic-API-Schlüssel. In EINSTELLUNGEN eintragen.")
    return {"x-api-key": config.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"}


def _error(response):
    try:
        message = response.json().get("error", {}).get("message", "")
    except (ValueError, AttributeError):
        message = ""
    message = str(message).replace(config.ANTHROPIC_API_KEY, "[Schlüssel]") if config.ANTHROPIC_API_KEY else str(message)
    if response.status_code == 401:
        return "Claude-Zugang ungültig. Anthropic-API-Schlüssel in EINSTELLUNGEN prüfen."
    if response.status_code == 404:
        return f"Claude-Modell {config.CLAUDE_MODEL} ist für diesen Zugang nicht verfügbar."
    if response.status_code == 429:
        return "Claude-Anfragelimit erreicht. Bitte später erneut versuchen."
    return f"Claude API {response.status_code}: {message[:300] or 'Anfrage fehlgeschlagen.'}"


def messages_payload(messages):
    """Convert the agent's common format, grouping all results after a tool-use turn.

    Preserve Claude's original blocks (including signed thinking blocks) verbatim.
    """
    system = "\n\n".join(str(m.get("content", "")) for m in messages if m["role"] == "system")
    out = []
    pending = []
    for index, m in enumerate(messages):
        role = m["role"]
        if role == "system":
            continue
        if role == "tool":
            if not pending:
                raise RuntimeError("Werkzeugantwort ohne zugehörigen Aufruf im KI-Verlauf.")
            expected = pending.pop(0)
            call_id = m.get("tool_call_id") or expected
            if call_id != expected:
                raise RuntimeError("Werkzeugantwort passt nicht zum KI-Aufruf.")
            block = {"type": "tool_result", "tool_use_id": call_id, "content": m.get("content") or "(leer)"}
            if m.get("is_error"):
                block["is_error"] = True
            if out and out[-1]["role"] == "user":
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue
        if pending:
            raise RuntimeError("Nicht alle KI-Werkzeugaufrufe haben eine Antwort erhalten.")
        blocks = copy.deepcopy(m.get("_claude_content"))
        if blocks is None:
            blocks = []
            if m.get("content"):
                blocks.append({"type": "text", "text": str(m["content"])})
            for data in m.get("images", []):
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": m.get("image_media_type", "image/jpeg"), "data": data}})
            for n, call in enumerate(m.get("tool_calls", [])):
                fn = call.get("function", {})
                args = fn.get("arguments") or {}
                if isinstance(args, str):
                    args = json.loads(args)
                blocks.append({"type": "tool_use", "id": call.get("id") or f"call_{index}_{n}", "name": fn["name"], "input": args})
        pending = [b["id"] for b in blocks if b.get("type") == "tool_use"]
        if not blocks:
            blocks = [{"type": "text", "text": "(leer)"}]
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": blocks})
    if pending:
        raise RuntimeError("Werkzeugaufrufe im Verlauf noch unbeantwortet.")
    return system, out


def _estimate_input(payload):
    images = 0

    def small(obj):
        nonlocal images
        if isinstance(obj, dict):
            if obj.get("type") == "image":
                images += 1
                return {"type": "image"}
            return {k: small(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [small(v) for v in obj]
        return obj

    return int(len(json.dumps(small(payload), ensure_ascii=False)) / 3.2 * 1.5) + images * 1600 + 200


async def call(messages, tools=None, max_tokens=None, model=None):
    headers = _headers()
    system, msgs = messages_payload(messages)
    payload = {"model": model or config.CLAUDE_MODEL, "max_tokens": max_tokens or config.CLAUDE_MAX_TOKENS,
               "messages": msgs, "stream": False}
    if system:
        payload["system"] = system
    if tools:
        payload["tools"] = [{"name": t["function"]["name"], "description": t["function"].get("description", ""),
                             "input_schema": t["function"]["parameters"]} for t in tools]
    # Sampling controls are omitted: newer Claude models reject temperature != 1.
    async with _lock:
        estimate = _estimate_input(payload) * config.PRICE_IN + payload["max_tokens"] * config.PRICE_OUT
        if config.DAILY_BUDGET_USD and db.cost_today() + estimate > config.DAILY_BUDGET_USD:
            raise BudgetExceeded("Claude-Tagesbudget erreicht. Limit in EINSTELLUNGEN anpassen oder Ollama wählen.")
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.CLAUDE_TIMEOUT_SEC, connect=10)) as client:
            for attempt in range(3):
                try:
                    response = await client.post(f"{API_URL}/messages", headers=headers, json=payload)
                except httpx.ConnectError:
                    if attempt < 2:
                        await asyncio.sleep(attempt + 1)
                        continue
                    raise CloudUnavailable("Claude ist nicht erreichbar. Internetverbindung prüfen.") from None
                except httpx.HTTPError:
                    raise CloudUnavailable("Claude-Anfrage unterbrochen oder Zeitlimit erreicht. Bitte erneut versuchen.") from None
                if response.status_code in (429, 500, 502, 503, 504, 529) and attempt < 2:
                    await asyncio.sleep(attempt + 1)
                    continue
                if response.status_code in (401, 403, 404):
                    raise CloudConfigError(_error(response))
                if response.status_code in (429, 529) or response.status_code >= 500:
                    raise CloudUnavailable(_error(response))
                if response.status_code >= 400:
                    raise RuntimeError(_error(response))
                try:
                    data = response.json()
                    blocks = data["content"]
                    if not isinstance(blocks, list):
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    raise RuntimeError("Claude hat eine ungültige Antwort geliefert.") from None
                usage = data.get("usage") or {}
                inp = usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
                created = usage.get("cache_creation_input_tokens", 0)
                out = usage.get("output_tokens", 0)
                cost = inp * config.PRICE_IN + created * config.PRICE_IN * 2 + out * config.PRICE_OUT
                db.add_usage(inp + created, out, 0, cost)
                calls = [{"id": b["id"], "function": {"name": b["name"], "arguments": b["input"]}}
                         for b in blocks if b.get("type") == "tool_use"]
                text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
                if data.get("stop_reason") == "max_tokens":
                    if calls:
                        raise RuntimeError("Claude-Ausgabelimit erreicht; unvollständige Werkzeugaufrufe wurden nicht ausgeführt.")
                    text += "\n[Antwort durch Ausgabelimit gekürzt.]"
                config.CLAUDE_STATUS.update(ok=True, model_ok=True, msg="bereit", checked=time.time())
                return {"message": {"content": text, "tool_calls": calls, "_claude_content": blocks}}
    raise RuntimeError("Claude-Anfrage fehlgeschlagen.")


async def check():
    status = config.CLAUDE_STATUS
    status.update(checked=time.time(), ok=False, model_ok=False)
    if not config.ANTHROPIC_API_KEY:
        status["msg"] = "Anthropic-API-Schlüssel fehlt – in EINSTELLUNGEN eintragen."
        return status
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # A direct model lookup verifies key and model access without generating tokens.
            from urllib.parse import quote
            response = await client.get(f"{API_URL}/models/{quote(config.CLAUDE_MODEL, safe='')}", headers=_headers())
            if response.status_code >= 400:
                status["msg"] = _error(response)
            else:
                status.update(ok=True, model_ok=True, msg="Zugang und Modell geprüft; KI-Antwort noch nicht getestet.")
    except httpx.HTTPError:
        status["msg"] = "Claude nicht erreichbar. Internetverbindung prüfen."
    return status
