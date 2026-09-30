"""J.A.R.V.I.S. – Hauptprozess für den PC (Server + Telegram + Autopilot + Tray-Icon + Hotkey).
Läuft absichtlich im normalen Benutzerkonto. Fenster öffnen: Doppelklick auf Desktop-Icon oder Strg+Alt+J."""
import asyncio
import os
import sys
import threading
import traceback
from pathlib import Path

APP = Path(__file__).resolve().parent
os.chdir(APP)
sys.path.insert(0, str(APP))
(APP / "data").mkdir(exist_ok=True)
_log = open(APP / "data" / "jarvis.log", "a", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr = _log  # pythonw hat keine Konsole

from jarvis import config, desktop  # noqa: E402

if desktop.running():  # läuft schon → nur Fenster zeigen
    if "--tray" not in sys.argv:
        desktop.open_window()
    sys.exit(0)

from jarvis import main as jarvis_main  # noqa: E402

loop = asyncio.new_event_loop()


def _run():
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(jarvis_main.main())
    except Exception:
        traceback.print_exc()


threading.Thread(target=_run, daemon=True).start()

# Globaler Hotkey (Standard Strg+Alt+J)
try:
    import keyboard
    keyboard.add_hotkey(config.HOTKEY, desktop.open_window)
except Exception as e:
    print("Hotkey nicht verfügbar:", e)

if "--show" in sys.argv:
    import time
    for _ in range(40):
        if desktop.running():
            break
        time.sleep(0.5)
    desktop.open_window()


def _quit(icon=None, _item=None):
    if icon:
        icon.stop()
    os._exit(0)


def _restart(icon=None, _item=None):
    import subprocess
    # Wait until this process has actually left. Otherwise the new process sees
    # the old /health endpoint and exits, leaving no Jarvis running.
    subprocess.Popen([sys.executable, str(APP / "Jarvis-Oeffnen.pyw"), "--restart", str(os.getpid())], cwd=APP)
    _quit(icon)


def _toggle_stop(icon=None, _item=None):
    from jarvis import guard
    guard.set_stop(not guard.stopped())
    try:
        icon.notify("NOTAUS AKTIV – alles gestoppt" if guard.stopped() else "NOTAUS aufgehoben", "J.A.R.V.I.S.")
    except Exception:
        pass


try:
    import pystray
    from PIL import Image

    img = Image.open(APP / "windows" / "jarvis.ico")
    menu = pystray.Menu(
        pystray.MenuItem("Jarvis öffnen", lambda i, _: desktop.open_window(), default=True),
        pystray.MenuItem("NOTAUS an/aus", _toggle_stop),
        pystray.MenuItem("Arbeitsordner", lambda i, _: os.startfile(config.WORKSPACE)),
        pystray.MenuItem("Einstellungen (.env)", lambda i, _: os.startfile(config.ENV_FILE)),
        pystray.MenuItem("Log anzeigen", lambda i, _: os.startfile(APP / "data" / "jarvis.log")),
        pystray.MenuItem("Neu starten", _restart),
        pystray.MenuItem("Beenden", _quit),
    )
    pystray.Icon("jarvis", img, "J.A.R.V.I.S. LOCAL – Strg+Alt+J", menu).run()
except Exception as e:
    print("Tray nicht verfügbar:", e)
    threading.Event().wait()
