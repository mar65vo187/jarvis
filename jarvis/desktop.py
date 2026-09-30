"""Desktop-Helfer: Jarvis-Fenster öffnen (Edge/Chrome im App-Modus), Laufstatus prüfen."""
import os
import shutil
import subprocess
import webbrowser
from pathlib import Path

import httpx

from . import config

URL = f"http://127.0.0.1:{config.PORT}/"


def running() -> bool:
    try:
        r = httpx.get(URL + "health", timeout=1.5)
        return r.status_code == 200 and r.json().get("app") == "jarvis"
    except Exception:
        return False


def _browser() -> str | None:
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                      Path(base) / "Google/Chrome/Application/chrome.exe"]
    for c in cands:
        if c.exists():
            return str(c)
    return shutil.which("msedge") or shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")


def open_window():
    exe = _browser()
    if not exe:
        webbrowser.open(URL)
        return
    profile = config.DATA_DIR / "window-profile"
    args = [exe, f"--app={URL}", f"--user-data-dir={profile}", "--window-size=1440,900",
            "--no-first-run", "--no-default-browser-check"]
    flags = 0x08000000 if config.IS_WINDOWS else 0
    if config.IS_WINDOWS and config.is_admin():
        # Browser nicht als Admin starten (sonst Warnleiste) → mit normalen Benutzerrechten öffnen
        cmdline = subprocess.list2cmdline(args)
        try:
            subprocess.Popen(["runas", "/trustlevel:0x20000", cmdline], creationflags=flags)
            return
        except Exception:
            pass
    subprocess.Popen(args, creationflags=flags)
