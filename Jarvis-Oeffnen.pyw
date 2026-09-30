"""Desktop-Icon: startet Jarvis im normalen Benutzerkontext und öffnet das lokale HUD."""
import os
import subprocess
import sys
import time
from pathlib import Path

APP = Path(__file__).resolve().parent
os.chdir(APP)
sys.path.insert(0, str(APP))
from jarvis import desktop  # noqa: E402

NO_WIN = 0x08000000

if "--restart" in sys.argv:
    idx = sys.argv.index("--restart")
    try:
        import psutil
        old = psutil.Process(int(sys.argv[idx + 1]))
        old.wait(timeout=15)
    except Exception:
        time.sleep(2)

def wait_up(sec):
    for _ in range(sec * 2):
        if desktop.running():
            return True
        time.sleep(0.5)
    return False

if not desktop.running():
    pyw = Path(sys.executable).with_name("pythonw.exe")
    subprocess.Popen([str(pyw if pyw.exists() else sys.executable), str(APP / "Jarvis.pyw"), "--tray"],
                     cwd=APP, creationflags=NO_WIN)
    wait_up(30)
desktop.open_window()
