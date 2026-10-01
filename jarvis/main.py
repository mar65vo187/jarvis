"""Startet Jarvis: lokales HUD + Telegram + Autopilot. Startet Ollama bei Bedarf selbst."""
import asyncio
import os
import shutil
import subprocess
import time
import traceback
from pathlib import Path

import httpx
import uvicorn

from . import autopilot, claude, config, huggingface, performance, telegram_bot, upgrades, xkiro
from .web import app

OLLAMA_STATUS = config.OLLAMA_STATUS  # gemeinsam genutzt (auch wenn als __main__ gestartet)


def _ollama_exe() -> str | None:
    exe = shutil.which("ollama")
    if exe:
        return exe
    cands = []
    if os.environ.get("LOCALAPPDATA"):
        cands.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Ollama" / "ollama.exe")
    if os.environ.get("ProgramFiles"):
        cands.append(Path(os.environ["ProgramFiles"]) / "Ollama" / "ollama.exe")
    for p in cands:
        if p.exists():
            return str(p)
    return None


def _has(names: set, model: str) -> bool:
    if not model:
        return False
    return any(n == model or n == f"{model}:latest" or (":" not in model and n.startswith(model + ":")) for n in names)


async def check_ollama(start_if_needed: bool = True) -> dict:
    OLLAMA_STATUS["checked"] = time.time()
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                r = await c.get(f"{config.OLLAMA_BASE_URL}/api/tags")
                r.raise_for_status()
            names = {m.get("name") for m in r.json().get("models", [])}
            OLLAMA_STATUS.update(ok=True, model_ok=_has(names, config.MODEL),
                                 vision_ok=_has(names, config.VISION_MODEL))
            OLLAMA_STATUS["msg"] = "bereit" if OLLAMA_STATUS["model_ok"] else \
                f"Modell {config.MODEL} fehlt – im Terminal: ollama pull {config.MODEL}"
            return OLLAMA_STATUS
        except Exception as e:
            OLLAMA_STATUS.update(ok=False, model_ok=False, msg=f"Ollama nicht erreichbar: {e}")
            # Auf dem Server verwaltet systemd Ollama – dort nie selbst starten.
            exe = _ollama_exe() if (start_if_needed and attempt == 0 and not config.SERVER) else None
            if not exe:
                break
            print("Starte Ollama …")
            # Sparsamer Betrieb: nur 1 Modell gleichzeitig, 1 Anfrage parallel, komprimierter Kontextspeicher.
            env = {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_NUM_PARALLEL": "1",
                   "OLLAMA_MAX_LOADED_MODELS": "1", **os.environ,
                   "OLLAMA_HOST": config.OLLAMA_BASE_URL.removeprefix("http://")}
            flags = 0x08000000 if config.IS_WINDOWS else 0
            subprocess.Popen([exe, "serve"], env=env, creationflags=flags,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(20):
                await asyncio.sleep(1)
                try:
                    async with httpx.AsyncClient(timeout=2) as c:
                        if (await c.get(f"{config.OLLAMA_BASE_URL}/api/tags")).status_code == 200:
                            break
                except Exception:
                    pass
    if start_if_needed:
        print("WARNUNG:", OLLAMA_STATUS["msg"])
    return OLLAMA_STATUS


async def _forever(name: str, factory):
    """Hält einen Dienst am Leben – ein Fehler darf nie den ganzen Jarvis beenden."""
    while True:
        try:
            await factory()
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            print(f"{name} abgestürzt, Neustart in 10 s:")
            traceback.print_exc()
            await asyncio.sleep(10)


async def main():
    mode = f"ONLINE ({config.PUBLIC_BASE_URL})" if config.SERVER else "lokal"
    print(f"J.A.R.V.I.S. startet {mode} | {config.provider_label()} | Modell {config.active_model()} | "
          f"Privatsphäre: {config.PRIVACY}")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=config.PORT, log_level="warning",
                                           proxy_headers=False))
    services = [asyncio.create_task(_forever("KI-Status", monitor_provider)),
                asyncio.create_task(_forever("Telegram", telegram_bot.run)),
                asyncio.create_task(_forever("Autopilot", autopilot.loop)),
                asyncio.create_task(_forever("Agent-Upgrades", upgrades.loop)),
                asyncio.create_task(_forever("Performance-Tuning", performance.loop))]
    try:
        await server.serve()
    finally:
        for task in services:
            task.cancel()
        await asyncio.gather(*services, return_exceptions=True)
        for task in list(telegram_bot._tasks):
            task.cancel()
        await asyncio.gather(*telegram_bot._tasks, return_exceptions=True)
        if telegram_bot._client:
            await telegram_bot._client.aclose()
            telegram_bot._client = None


async def check_provider(start_if_needed=False):
    provider = config.active_provider()
    if provider != "ollama":
        # Lokale KI immer mitprüfen: sie verarbeitet private Aufgaben und springt bei Cloud-Ausfall ein
        await check_ollama(start_if_needed=start_if_needed)
    if provider == "claude":
        return await claude.check()
    if provider == "xkiro":
        return await xkiro.check()
    if provider == "huggingface":
        return await huggingface.check()
    return await check_ollama(start_if_needed=start_if_needed)


async def monitor_provider():
    while True:
        await check_provider(start_if_needed=True)
        await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(main())
