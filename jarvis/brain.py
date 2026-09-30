"""Agent-Schleife mit austauschbarem Claude-/Ollama-Gehirn und Werkzeugen."""
import asyncio
import json
import re
from typing import Any

import httpx

from . import claude, config, db, prompts, xkiro
from .tools import all_schemas, run_tool


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


BudgetExceeded = claude.BudgetExceeded


def _ollama_tools() -> list[dict]:
    """Konvertiert die vorhandenen JSON-Schemas in Ollamas OpenAI-kompatibles Tool-Format."""
    out = []
    for t in all_schemas():
        # Serverseitige Anthropic-Spezialtools gibt es lokal nicht.
        if "input_schema" not in t:
            continue
        out.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t["input_schema"],
            },
        })
    return out


async def _call(messages: list[dict], tools: list[dict] | None = None, max_tokens: int | None = None,
                model: str | None = None) -> dict:
    provider = config.active_provider()
    if provider == "claude":
        return await claude.call(messages, tools=tools, max_tokens=max_tokens, model=model)
    if provider == "xkiro":
        return await xkiro.call(messages, tools=tools, max_tokens=max_tokens, model=model)
    return await _ollama_call(messages, tools, max_tokens, model)


_ollama_lock = asyncio.Lock()


async def _ollama_call(messages, tools=None, max_tokens=None, model=None):
    async with _ollama_lock:
        return await _ollama_request(messages, tools, max_tokens, model)


async def _ollama_request(messages, tools=None, max_tokens=None, model=None):
    model = model or config.MODEL
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": config.KEEP_ALIVE,
        "options": {"num_predict": max_tokens or config.MAX_TOKENS, "temperature": config.TEMPERATURE,
                    "num_ctx": config.NUM_CTX},
    }
    if not config.THINK:
        payload["think"] = False
    if tools:
        payload["tools"] = tools
    delay = 1.0
    async with httpx.AsyncClient(timeout=httpx.Timeout(config.OLLAMA_TIMEOUT_SEC, connect=5)) as c:
        for attempt in range(5):
            try:
                r = await c.post(f"{config.OLLAMA_BASE_URL}/api/chat", json=payload)
            except httpx.HTTPError:
                if attempt == 4:
                    raise RuntimeError(
                        f"Ollama ist nicht erreichbar unter {config.OLLAMA_BASE_URL}. "
                        "Starte Ollama und führe ggf. 'ollama serve' aus."
                    )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 8)
                continue
            low = r.text.lower()
            if r.status_code >= 500 and ("memory" in low or "alloc" in low):
                raise RuntimeError(
                    "Zu wenig freier Arbeitsspeicher für das KI-Modell. Schließe große Programme (Browser-Tabs, Spiele) "
                    f"und versuch es nochmal. Details: {r.text[:200]}")
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 4:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 8)
                continue
            if r.status_code == 404:
                raise RuntimeError(f"Ollama-Modell '{model}' fehlt. Bitte 'ollama pull {model}' ausführen.")
            if r.status_code == 400 and "think" in payload and "think" in r.text.lower():
                payload.pop("think", None)  # Modell ohne Denkmodus-Schalter
                continue
            if r.status_code == 400 and tools and "does not support tools" in r.text:
                raise RuntimeError(f"Das Modell '{model}' kann keine Werkzeuge benutzen. "
                                   "Bitte ein Tool-fähiges Modell wählen (z.B. qwen3:8b).")
            if r.status_code >= 400:
                raise RuntimeError(f"Ollama API {r.status_code}: {r.text[:500]}")
            return r.json()
    raise RuntimeError("Ollama ist nicht erreichbar.")


VISION_PROMPT = (
    "Beschreibe diesen Bildschirm/dieses Bild präzise auf Deutsch für einen Assistenten, der den PC bedienen soll: "
    "1) Welches Programm/Fenster ist offen, was ist zu sehen (Texte wörtlich, Fehlermeldungen vollständig). "
    "2) Liste die wichtigsten klickbaren Elemente (Buttons, Felder, Links, Menüs) mit ungefähren Pixel-Koordinaten "
    "ihrer Mitte im Format „Element – x,y“. Das Bild ist {w}x{h} Pixel groß.")


async def describe_image(b64: str, w: int = 0, h: int = 0, question: str = "") -> str:
    """Lässt das optionale lokale Seh-Modell ein Bild beschreiben. Ohne Seh-Modell: ehrlicher Hinweis."""
    provider = config.active_provider()
    if provider == "ollama" and not config.VISION_MODEL:
        return ("[Bild vorhanden, aber kein Seh-Modell eingerichtet. Ohne JARVIS_VISION_MODEL kann ich den Inhalt "
                "nicht sehen – nutze stattdessen windows/clipboard/PowerShell oder bitte den Owner.]")
    prompt = VISION_PROMPT.format(w=w or "?", h=h or "?") + (f"\nZusatzfrage: {question}" if question else "")
    vision_model = config.CLAUDE_MODEL if provider == "claude" else config.XKIRO_MODEL if provider == "xkiro" else config.VISION_MODEL
    try:
        resp = await _call([{"role": "user", "content": prompt, "images": [b64]}], tools=None,
                           max_tokens=1200, model=vision_model)
        return "[Bildanalyse]\n" + ((resp.get("message") or {}).get("content") or "").strip()
    except Exception as e:
        return f"[Bildanalyse fehlgeschlagen: {e}]"


async def _normalize_tool_result(out: Any) -> str:
    """Ollama bekommt Werkzeugresultate als Text. Bilder werden vom Seh-Modell in Text übersetzt."""
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        texts = []
        for item in out:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(str(item.get("text", "")))
            elif isinstance(item, dict) and item.get("type") == "image":
                src = item.get("source") or {}
                texts.append(await describe_image(src.get("data", ""), item.get("w", 0), item.get("h", 0)))
            else:
                texts.append(json.dumps(item, ensure_ascii=False, default=str))
        return "\n".join(texts)
    return json.dumps(out, ensure_ascii=False, default=str)


def _est_tokens(obj) -> int:
    """Grobe Schätzung (Deutsch ≈ 3,2 Zeichen pro Token) – reicht, um das Kontextfenster nicht zu sprengen."""
    return int(len(json.dumps(obj, ensure_ascii=False)) / 3.2) + 1


def _fit_context(msgs: list[dict], tools: list[dict]) -> list[dict]:
    """Hält Systemprompt + Werkzeuge + Verlauf im Kontextfenster (wichtig bei wenig RAM / kleinem num_ctx).
    Reihenfolge: alte Werkzeug-Ergebnisse kürzen → älteste Nachrichten entfernen. Systemprompt und
    die aktuelle Anfrage bleiben immer erhalten."""
    provider = config.active_provider()
    if provider == "claude":
        ctx, output = config.CLAUDE_NUM_CTX, config.CLAUDE_MAX_TOKENS
    elif provider == "xkiro":
        ctx, output = config.XKIRO_NUM_CTX, config.XKIRO_MAX_TOKENS
    else:
        ctx, output = config.NUM_CTX, config.MAX_TOKENS
    budget = ctx - min(output, ctx // 3) - _est_tokens(tools)
    if _est_tokens(msgs) <= budget:
        return msgs
    # Remove complete old user turns, never an assistant tool-use or its matching results.
    while _est_tokens(msgs) > budget and len(msgs) > 3:
        # ältestes Element nach dem Systemprompt entfernen, aber nie die letzte Nutzeranfrage
        last_user = max(i for i, m in enumerate(msgs) if m.get("role") == "user")
        if last_user <= 1:
            break
        following = next((i for i in range(2, len(msgs)) if msgs[i].get("role") == "user"), last_user)
        del msgs[1:following]
    if _est_tokens(msgs) > budget:  # immer noch zu groß: lange Inhalte hart kürzen
        for m in msgs[1:]:
            c = m.get("content", "")
            if m.get("role") == "tool" and len(c) > 2000:
                m["content"] = c[:2000] + " …[gekürzt]"
    if _est_tokens(msgs) > budget:
        raise RuntimeError("Aktuelle Aufgabe und Werkzeuge passen nicht in das Kontextfenster. Kontextgröße erhöhen oder Aufgabe kürzen.")
    return msgs


async def think(messages: list, ctx: dict, extra_system: str = "", max_steps: int | None = None,
                on_tool=None) -> str:
    system = prompts.system_prompt(extra_system)
    history = [dict(m) for m in messages]
    # Uhrzeit NICHT in den Systemprompt (sonst ändert er sich jede Minute und Ollama kann den
    # vorberechneten Anfang nicht wiederverwenden → auf schwachen PCs deutlich langsamer).
    for m in reversed(history):
        if m.get("role") == "user":
            m["content"] = f"[Jetzt: {prompts.now_str()}]\n{m['content']}"
            break
    ollama_messages = [{"role": "system", "content": system}] + history
    tools = _ollama_tools()
    max_steps = max_steps or config.CHAT_MAX_STEPS
    final_text = ""

    for _step in range(max_steps):
        ollama_messages = _fit_context(ollama_messages, tools)
        resp = await _call(ollama_messages, tools=tools)
        msg = resp.get("message") or {}
        content = _THINK_RE.sub("", msg.get("content") or "").strip()
        tool_calls = msg.get("tool_calls") or []
        if content:
            final_text = content
        assistant_msg = {"role": "assistant", "content": content}
        if msg.get("_claude_content") is not None:
            assistant_msg["_claude_content"] = msg["_claude_content"]
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        ollama_messages.append(assistant_msg)
        if not tool_calls:
            break

        for call in tool_calls:
            fn = (call or {}).get("function") or {}
            name = fn.get("name", "")
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            if on_tool:
                try:
                    await on_tool(name, args)
                except Exception:
                    pass
            out, is_err = await run_tool(name, args, ctx)
            result = await _normalize_tool_result(out)
            if len(result) > config.TOOL_RESULT_MAX:
                result = result[:config.TOOL_RESULT_MAX] + f"\n…[gekürzt, {len(result) - config.TOOL_RESULT_MAX} Zeichen mehr]"
            if is_err:
                result = "FEHLER: " + result
            ollama_messages.append({"role": "tool", "content": result, "tool_name": name,
                                    "tool_call_id": call.get("id"), "is_error": is_err})
    else:
        ollama_messages.append({"role": "user", "content":
                                "Schrittlimit erreicht. Fasse kurz zusammen, was erledigt ist und was offen bleibt."})
        resp = await _call(_fit_context(ollama_messages, []), tools=None, max_tokens=800)
        final_text = _THINK_RE.sub("", (resp.get("message") or {}).get("content") or final_text).strip()

    return final_text or "Die KI hat keine abschließende Antwort geliefert. Prüfe den Aufgabenstatus."


_locks: dict[str, asyncio.Lock] = {}


async def chat(channel: str, text: str, on_tool=None) -> str:
    lock = _locks.setdefault(channel, asyncio.Lock())
    async with lock:
        msgs = db.history(channel, config.HISTORY_TURNS)
        msgs.append({"role": "user", "content": text})
        try:
            reply = await think(msgs, {"channel": channel}, on_tool=on_tool)
        except Exception as e:
            reply = f"KI konnte die Anfrage nicht ausführen: {e}"
        db.add_message(channel, "user", text)
        db.add_message(channel, "assistant", reply)
        return reply
