"""Agent-Schleife mit austauschbarem Gehirn (xKiro, Claude oder lokale KI/Ollama) und Werkzeugen.

Privatsphäre (siehe privacy.py): Private Aufgaben – und im Modus „strikt“ alle – laufen nur über die
lokale KI. Cloud-KIs dienen dann nur noch als Lehrer für allgemeine Fragen; ihr Wissen fließt in den
eigenen Wissensspeicher (knowledge.py). Bei vorübergehendem Cloud-Ausfall arbeitet Jarvis (wenn erlaubt)
im selben Verlauf mit der lokalen KI weiter, ohne bereits ausgeführte Werkzeuge zu wiederholen.
"""
import asyncio
import time
import json
import re
from typing import Any

import httpx

from . import agents, claude, config, db, huggingface, knowledge, privacy, prompts, xkiro
from .errors import BudgetExceeded, CloudUnavailable, PrivacyBlocked
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


LAST_PROVIDER = {"provider": "", "model": "", "error": ""}


def _provider_chain() -> list[str]:
    """Configured failover chain. Only used when JARVIS_PROVIDER=auto."""
    if not config.CLOUD_ENABLED:
        return ["ollama"]
    chain = []
    if config.XKIRO_API_KEY:
        chain.append("xkiro")
    if config.HF_TOKEN:
        chain.append("huggingface")
    if config.ANTHROPIC_API_KEY:
        chain.append("claude")
    if config.FALLBACK_LOCAL or not chain:
        chain.append("ollama")
    return chain


async def _call_provider(provider: str, messages, tools=None, max_tokens=None, model=None):
    if provider == "claude":
        return await claude.call(messages, tools=tools, max_tokens=max_tokens, model=model)
    if provider == "xkiro":
        return await xkiro.call(messages, tools=tools, max_tokens=max_tokens, model=model)
    if provider == "huggingface":
        return await huggingface.call(messages, tools=tools, max_tokens=max_tokens, model=model)
    return await _ollama_call(messages, tools, max_tokens, model)


LAST_ROUTE: dict = {"provider": "", "private": False}


def _keep_alive():
    """Ollama erwartet Dauer-Text ("5m") oder Zahl (Sekunden, -1 = immer geladen)."""
    ka = str(config.KEEP_ALIVE).strip()
    try:
        return int(ka)
    except ValueError:
        return ka


async def _cloud_call(provider, messages, tools, max_tokens, model):
    """Direkter Aufruf einer Cloud-KI (nur für Lehrer-Fragen ohne private Daten)."""
    return await _call_provider(provider, messages, tools, max_tokens, model)


async def _local_only(messages, tools, max_tokens, model, provider):
    """Privatsphäre: private Inhalte (und im Modus „strikt“ alles) nur über die lokale KI."""
    has_images = any(m.get("images") for m in messages)
    if has_images:
        model = model if provider == "ollama" and model else config.VISION_MODEL
        if not model:
            raise PrivacyBlocked("Bilder werden nur lokal ausgewertet, es ist aber kein lokales Seh-Modell "
                                 "(JARVIS_VISION_MODEL) eingerichtet.")
    elif provider != "ollama":
        model = None
    if provider != "ollama":
        messages = _fit_context([dict(m) for m in messages], tools or [], local=True)
    try:
        resp = await _ollama_call(messages, tools, max_tokens, model)
    except RuntimeError as e:
        if provider != "ollama":
            raise PrivacyBlocked(f"Private Daten bleiben bei deiner eigenen KI – die lokale KI ist aber gerade "
                                 f"nicht bereit ({e}). Nichts wurde an eine Cloud gesendet.") from None
        raise
    LAST_PROVIDER.update(provider="ollama", model=model or config.MODEL, error="")
    LAST_ROUTE.update(provider="ollama")
    return resp


async def _call(messages: list[dict], tools: list[dict] | None = None, max_tokens: int | None = None,
                model: str | None = None, private: bool = False) -> dict:
    # Privatsphäre zuerst (Einbahnstraße): private Inhalte, Bilder und Modus „strikt“ → nur lokal.
    provider = config.active_provider()
    has_images = any(m.get("images") for m in messages)
    local_only = private or privacy.must_stay_local(messages) or has_images
    LAST_ROUTE.update(private=local_only)
    if local_only:
        return await _local_only(messages, tools, max_tokens, model, provider)
    # An explicit model belongs to the selected provider (e.g. vision); never send
    # that provider-specific ID to a different API. Normal master calls in AUTO
    # mode are safe to fail over because a failed model request has not executed
    # Jarvis side effects. Tool results already in the history are merely continued.
    providers = [config.active_provider()]
    if config.PROVIDER == "auto" and model is None:
        providers = _provider_chain()
    errors = []
    for provider in providers:
        try:
            result = await _call_provider(provider, messages, tools, max_tokens, model)
            runtime_model = (config.XKIRO_MODEL if provider == "xkiro" else
                             config.HF_MODEL if provider == "huggingface" else
                             config.CLAUDE_MODEL if provider == "claude" else config.MODEL)
            LAST_PROVIDER.update(provider=provider, model=runtime_model, error="")
            LAST_ROUTE.update(provider=provider)
            if provider != "ollama":
                config.FALLBACK_STATUS.update(active=False, reason="")
            return result
        except Exception as exc:
            errors.append(f"{provider}: {str(exc)[:220]}")
            LAST_PROVIDER.update(provider=provider, model="", error=str(exc)[:300])
            if config.PROVIDER != "auto" or model is not None:
                # Ausfall (nicht Einrichtungsfehler) → mit der eigenen lokalen KI weiterarbeiten.
                if (isinstance(exc, (CloudUnavailable, BudgetExceeded)) and model is None and provider != "ollama"
                        and config.FALLBACK_LOCAL and config.OLLAMA_STATUS.get("ok")):
                    config.FALLBACK_STATUS.update(active=True, reason=str(exc)[:200], ts=time.time())
                    local_msgs = _fit_context([dict(m) for m in messages], tools or [], local=True)
                    result = await _ollama_call(local_msgs, tools, max_tokens, None)
                    LAST_PROVIDER.update(provider="ollama", model=config.MODEL, error="")
                    LAST_ROUTE.update(provider="ollama")
                    return result
                raise
    raise RuntimeError("Alle konfigurierten KI-Wege sind fehlgeschlagen: " + " | ".join(errors))


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
        "keep_alive": _keep_alive(),
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
    """Bilder (Bildschirm, Fotos) sind privat: nur das LOKALE Seh-Modell beschreibt sie."""
    if not config.VISION_MODEL:
        return ("[Bild vorhanden, aber kein Seh-Modell eingerichtet. Ohne JARVIS_VISION_MODEL kann ich den Inhalt "
                "nicht sehen – nutze stattdessen windows/clipboard/PowerShell oder bitte den Owner.]")
    prompt = VISION_PROMPT.format(w=w or "?", h=h or "?") + (f"\nZusatzfrage: {question}" if question else "")
    vision_model = config.VISION_MODEL
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


def _fit_context(msgs: list[dict], tools: list[dict], local: bool = False) -> list[dict]:
    """Hält Systemprompt + Werkzeuge + Verlauf im Kontextfenster (wichtig bei wenig RAM / kleinem num_ctx).
    Reihenfolge: alte Werkzeug-Ergebnisse kürzen → älteste Nachrichten entfernen. Systemprompt und
    die aktuelle Anfrage bleiben immer erhalten."""
    provider = "ollama" if local else config.active_provider()
    if local:
        ctx, output = config.NUM_CTX, config.MAX_TOKENS
    elif config.PROVIDER == "auto":
        # AUTO promises failover, so fit to the smallest configured fallback
        # instead of preparing a 200k cloud context that local Ollama cannot accept.
        windows = [(config.NUM_CTX, config.MAX_TOKENS)]
        if config.XKIRO_API_KEY:
            windows.append((config.XKIRO_NUM_CTX, config.XKIRO_MAX_TOKENS))
        if config.HF_TOKEN:
            windows.append((config.HF_NUM_CTX, config.HF_MAX_TOKENS))
        if config.ANTHROPIC_API_KEY:
            windows.append((config.CLAUDE_NUM_CTX, config.CLAUDE_MAX_TOKENS))
        ctx = min(x[0] for x in windows)
        output = min(x[1] for x in windows)
    elif provider == "claude":
        ctx, output = config.CLAUDE_NUM_CTX, config.CLAUDE_MAX_TOKENS
    elif provider == "xkiro":
        ctx, output = config.XKIRO_NUM_CTX, config.XKIRO_MAX_TOKENS
    elif provider == "huggingface":
        ctx, output = config.HF_NUM_CTX, config.HF_MAX_TOKENS
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
    history = [dict(m) for m in messages]
    ctx = ctx if ctx is not None else {}
    if any(m.get("private") for m in history):  # „privat“ = es sind private DATEN im Spiel
        ctx["private"] = True
    last_user = next((m.get("content", "") for m in reversed(history) if m.get("role") == "user"), "")
    learned = knowledge.context_block(str(last_user))  # eigenes Wissen (nur herein)

    def _system(local: bool) -> str:
        extra = "\n\n".join(x for x in (extra_system, learned) if x)
        return prompts.system_prompt(extra, local=local)

    system = _system(privacy.must_stay_local(history, ctx) or config.active_provider() == "ollama")
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

    for step in range(max_steps):
        if ctx.get("private"):  # Markierung wandert mit dem Verlauf – _call sieht sie in jeder Nachricht
            for m in ollama_messages:
                m["private"] = True
        local = privacy.must_stay_local(ollama_messages, ctx) or config.active_provider() == "ollama"
        ollama_messages[0] = {"role": "system", "content": _system(local), "private": bool(ctx.get("private"))}
        ollama_messages = _fit_context(ollama_messages, tools, local=local)
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
                                    "tool_call_id": call.get("id"), "is_error": is_err,
                                    "private": bool(ctx.get("private"))})
    else:
        ollama_messages.append({"role": "user", "content":
                                "Schrittlimit erreicht. Fasse kurz zusammen, was erledigt ist und was offen bleibt."})
        local = privacy.must_stay_local(ollama_messages, ctx) or config.active_provider() == "ollama"
        resp = await _call(_fit_context(ollama_messages, [], local=local), tools=None, max_tokens=800)
        final_text = _THINK_RE.sub("", (resp.get("message") or {}).get("content") or final_text).strip()

    return final_text or "Die KI hat keine abschließende Antwort geliefert. Prüfe den Aufgabenstatus."


_locks: dict[str, asyncio.Lock] = {}


async def chat(channel: str, text: str, on_tool=None) -> str:
    lock = _locks.setdefault(channel, asyncio.Lock())
    async with lock:
        explicit = privacy.explicit_private(text)
        text = privacy.strip_prefix(text) if explicit else text
        private_in = explicit or bool(privacy.sensitive_findings(text))
        msgs = db.history(channel, config.HISTORY_TURNS)
        msgs.append({"role": "user", "content": text, "private": private_in})
        ctx = {"channel": channel}
        if any(m.get("private") for m in msgs):
            ctx["private"] = True
        try:
            council_context = ""
            if not ctx.get("private") and config.PRIVACY == "smart":  # Spezialisten nur für Nicht-Privates
                try:
                    council_context = await agents.council(text)
                except Exception:
                    # Specialist failure must never take the master Jarvis offline.
                    council_context = ""
            reply = await think(msgs, ctx, extra_system=council_context, on_tool=on_tool)
        except Exception as e:
            reply = f"KI konnte die Anfrage nicht ausführen: {e}"
        private = bool(ctx.get("private"))
        db.add_message(channel, "user", text, private=private)
        db.add_message(channel, "assistant", reply, private=private)
        # Wissen HEREIN: gute Cloud-Antworten auf nicht-private Fragen werden Jarvis' eigenes Wissen
        if (not private and config.LEARN_FROM_CLOUD and LAST_ROUTE.get("provider") in ("xkiro", "huggingface", "claude")
                and len(reply) >= 200 and not reply.startswith("KI konnte")):
            knowledge.learn(text, reply, config.provider_label(LAST_ROUTE["provider"]))
        return reply
