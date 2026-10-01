"""Tiny Windows watchdog: keeps the local Jarvis/Telegram runtime alive after login."""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent
os.chdir(APP)
DATA = APP / "data"
DATA.mkdir(exist_ok=True)
LOG = DATA / "watchdog.log"


def _port() -> int:
    env = APP / ".env"
    if env.exists():
        try:
            for line in env.read_text(encoding="utf-8-sig").splitlines():
                if line.strip().startswith("PORT="):
                    return int(line.split("=", 1)[1].strip().strip('"\''))
        except Exception:
            pass
    return 8765


def _healthy() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{_port()}/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _log(text: str):
    try:
        if LOG.exists() and LOG.stat().st_size > 1_000_000:
            LOG.replace(LOG.with_suffix(".log.old"))
        with LOG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except Exception:
        pass


def _start():
    target = APP / "Jarvis.pyw"
    if not target.exists():
        _log("Jarvis.pyw fehlt")
        return
    flags = 0x08000000 if os.name == "nt" else 0
    try:
        subprocess.Popen([sys.executable, str(target), "--tray"], cwd=APP,
                         creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _log("Jarvis neu gestartet")
    except Exception as exc:
        _log(f"Startfehler: {exc}")


failures = 0
while True:
    if _healthy():
        failures = 0
    else:
        failures += 1
        if failures >= 2:
            _start()
            failures = 0
            time.sleep(20)
    time.sleep(30)
