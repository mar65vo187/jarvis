"""PC-Steuerung: Bildschirm sehen, Maus, Tastatur, Fenster, Apps, Zwischenablage, Systemstatus.
Nur aktiv, wenn Jarvis lokal auf einem PC mit Bildschirm läuft (Windows)."""
import asyncio
import base64
import io
import os
import subprocess
import sys

from . import config

AVAILABLE = False
REASON = ""
_scale = 1.0

if config.LOCAL:
    try:
        if config.IS_WINDOWS:
            import ctypes
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(2)  # echte Pixel, passend zu Screenshots
            except Exception:
                ctypes.windll.user32.SetProcessDPIAware()
        import pyautogui
        import pyperclip
        from PIL import ImageGrab

        pyautogui.FAILSAFE = True  # NOTAUS: Maus in eine Bildschirmecke ziehen
        pyautogui.PAUSE = 0.08
        AVAILABLE = True
    except Exception as e:  # noqa
        REASON = f"{type(e).__name__}: {e}"
else:
    REASON = "Server-Modus (kein Bildschirm)"

MAX_W = 1366


def _to_real(x, y):
    return int(round(float(x) * _scale)), int(round(float(y) * _scale))


def _grab():
    global _scale
    img = ImageGrab.grab()
    w, h = img.size
    _scale = w / MAX_W if w > MAX_W else 1.0
    if _scale != 1.0:
        img = img.resize((MAX_W, int(h / _scale)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=70)
    return img.size, base64.b64encode(buf.getvalue()).decode()


async def screenshot(**_):
    (w, h), b64 = await asyncio.to_thread(_grab)
    return [
        {"type": "text", "text": f"Screenshot {w}x{h}. Koordinaten für click/move beziehen sich auf dieses Bild."},
        {"type": "image", "w": w, "h": h, "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
    ]


async def _maybe_shot(after: bool, msg: str):
    if not after:
        return msg
    await asyncio.sleep(0.6)
    shot = await screenshot()
    shot[0]["text"] = msg + "\n" + shot[0]["text"]
    return shot


async def click(x: float, y: float, button: str = "left", clicks: int = 1, screenshot_after: bool = False, **_):
    rx, ry = _to_real(x, y)
    await asyncio.to_thread(pyautogui.click, rx, ry, clicks=clicks, button=button)
    return await _maybe_shot(screenshot_after, f"Klick ({button} x{clicks}) bei {x},{y}.")


async def move_mouse(x: float, y: float, **_):
    rx, ry = _to_real(x, y)
    await asyncio.to_thread(pyautogui.moveTo, rx, ry, 0.2)
    return "Maus bewegt."


async def drag(x1: float, y1: float, x2: float, y2: float, **_):
    a, b = _to_real(x1, y1)
    c, d = _to_real(x2, y2)
    def _d():
        pyautogui.moveTo(a, b)
        pyautogui.dragTo(c, d, 0.5, button="left")
    await asyncio.to_thread(_d)
    return "Gezogen."


async def type_text(text: str, enter: bool = False, screenshot_after: bool = False, **_):
    """Über die Zwischenablage – funktioniert auch mit Umlauten und Emojis."""
    def _t():
        try:
            old = pyperclip.paste()
        except Exception:
            old = None
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
        if enter:
            pyautogui.press("enter")
        if old is not None:
            import time
            time.sleep(0.3)
            pyperclip.copy(old)
    await asyncio.to_thread(_t)
    return await _maybe_shot(screenshot_after, f"Getippt ({len(text)} Zeichen){' + Enter' if enter else ''}.")


async def press_keys(keys: str, screenshot_after: bool = False, **_):
    """z.B. 'ctrl+s', 'enter', 'win+r', 'alt+tab', 'ctrl+shift+esc'"""
    combo = [k.strip().lower() for k in keys.replace(" ", "").split("+") if k.strip()]
    alias = {"win": "winleft", "windows": "winleft", "strg": "ctrl", "entf": "delete", "esc": "escape"}
    combo = [alias.get(k, k) for k in combo]
    await asyncio.to_thread(pyautogui.hotkey, *combo)
    return await _maybe_shot(screenshot_after, f"Tasten: {keys}")


async def scroll(amount: int, x: float | None = None, y: float | None = None, **_):
    if x is not None and y is not None:
        rx, ry = _to_real(x, y)
        await asyncio.to_thread(pyautogui.scroll, int(amount), rx, ry)
    else:
        await asyncio.to_thread(pyautogui.scroll, int(amount))
    return f"Gescrollt ({amount})."


async def open_item(target: str, **_):
    """Öffnet Datei, Ordner, URL, Programm (z.B. 'notepad', 'excel', 'C:\\...\\datei.pdf', 'https://…', 'spotify:')."""
    def _o():
        if config.IS_WINDOWS:
            try:
                os.startfile(target)  # type: ignore[attr-defined]
                return
            except OSError:
                subprocess.Popen(["powershell", "-NoProfile", "-Command", f"Start-Process '{target}'"],
                                 creationflags=0x08000000)
        else:
            subprocess.Popen(["xdg-open", target])
    await asyncio.to_thread(_o)
    return f"Geöffnet: {target}"


async def windows(action: str = "list", title: str = "", **_):
    import pygetwindow as gw
    if action == "list":
        wins = [w for w in gw.getAllWindows() if w.title.strip() and w.width > 50]
        act = gw.getActiveWindow()
        return "\n".join(f"{'▶ ' if act and w._hWnd == act._hWnd else '  '}{w.title}" for w in wins[:60]) or "Keine Fenster."
    matches = [w for w in gw.getAllWindows() if title.lower() in w.title.lower() and w.title.strip()]
    if not matches:
        return f"Kein Fenster mit '{title}'."
    w = matches[0]
    def _a():
        if action == "focus":
            if w.isMinimized:
                w.restore()
            try:
                w.activate()
            except Exception:
                pyautogui.press("alt")  # Windows-Fokus-Sperre umgehen
                w.activate()
        elif action == "minimize":
            w.minimize()
        elif action == "maximize":
            w.maximize()
        elif action == "close":
            w.close()
    await asyncio.to_thread(_a)
    return f"{action}: {w.title}"


async def clipboard(action: str = "get", text: str = "", **_):
    if action == "set":
        pyperclip.copy(text)
        return "Zwischenablage gesetzt."
    return pyperclip.paste()[:20000] or "(leer)"


async def system_status(**_):
    import psutil
    vm = psutil.virtual_memory()
    out = [f"System: {config.SYSTEM_INFO}", f"Admin-Rechte: {'JA' if config.is_admin() else 'nein'}",
           f"CPU: {psutil.cpu_percent(interval=0.5)}%", f"RAM: {vm.percent}% von {vm.total / 1e9:.1f} GB"]
    for part in psutil.disk_partitions():
        try:
            u = psutil.disk_usage(part.mountpoint)
            out.append(f"Laufwerk {part.mountpoint}: {u.free / 1e9:.0f} GB frei von {u.total / 1e9:.0f} GB")
        except Exception:
            pass
    bat = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
    if bat:
        out.append(f"Akku: {bat.percent}% {'(lädt)' if bat.power_plugged else ''}")
    procs = sorted(psutil.process_iter(["name", "memory_info"]), key=lambda p: -(p.info["memory_info"].rss if p.info["memory_info"] else 0))[:10]
    out.append("Top-Prozesse (RAM): " + ", ".join(f"{p.info['name']} {p.info['memory_info'].rss / 1e6:.0f}MB" for p in procs if p.info["memory_info"]))
    return "\n".join(out)


async def wait(seconds: float = 2, **_):
    await asyncio.sleep(min(float(seconds), 60))
    return f"{seconds}s gewartet."


def _t(name, desc, props, req=None):
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": req or []}}


N = {"type": "number"}
B = {"type": "boolean"}
S = {"type": "string"}
SHOT = {"type": "boolean", "description": "Danach Screenshot zur Kontrolle zurückgeben"}

SCHEMAS = [
    _t("screenshot", "Macht einen Screenshot vom Hauptbildschirm des PCs, damit du siehst, was los ist.", {}),
    _t("click", "Klickt an Koordinaten (aus dem letzten Screenshot).",
       {"x": N, "y": N, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "clicks": {"type": "integer"},
        "screenshot_after": SHOT}, ["x", "y"]),
    _t("move_mouse", "Bewegt die Maus.", {"x": N, "y": N}, ["x", "y"]),
    _t("drag", "Zieht mit gedrückter Maustaste von (x1,y1) nach (x2,y2).", {"x1": N, "y1": N, "x2": N, "y2": N},
       ["x1", "y1", "x2", "y2"]),
    _t("type_text", "Tippt Text ins aktive Feld (Umlaute ok).", {"text": S, "enter": B, "screenshot_after": SHOT}, ["text"]),
    _t("press_keys", "Drückt Tasten/Kombis: 'enter', 'ctrl+s', 'win+r', 'alt+tab', 'ctrl+shift+esc'.",
       {"keys": S, "screenshot_after": SHOT}, ["keys"]),
    _t("scroll", "Scrollt (positiv = hoch, negativ = runter).", {"amount": {"type": "integer"}, "x": N, "y": N}, ["amount"]),
    _t("open", "Öffnet Programm, Datei, Ordner oder URL auf dem PC (z.B. 'notepad', 'excel', 'C:\\\\Users\\\\…\\\\x.pdf', 'https://…').",
       {"target": S}, ["target"]),
    _t("windows", "Fenster: list | focus | minimize | maximize | close (per Titel-Teil).",
       {"action": {"type": "string", "enum": ["list", "focus", "minimize", "maximize", "close"]}, "title": S}),
    _t("clipboard", "Zwischenablage lesen (get) oder setzen (set).",
       {"action": {"type": "string", "enum": ["get", "set"]}, "text": S}),
    _t("system_status", "CPU, RAM, Laufwerke, Akku, Top-Prozesse, Admin-Status.", {}),
    _t("wait", "Wartet kurz (z.B. bis ein Programm geladen ist).", {"seconds": N}),
]
HANDLERS = {"screenshot": screenshot, "click": click, "move_mouse": move_mouse, "drag": drag,
            "type_text": type_text, "press_keys": press_keys, "scroll": scroll, "open": open_item,
            "windows": windows, "clipboard": clipboard, "system_status": system_status, "wait": wait}
