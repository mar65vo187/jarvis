"""Sicherheits-Schicht, die im CODE greift (nicht nur im Prompt):

- Pfade: voller Zugriff auf alles, was dein Windows-Benutzer darf (JARVIS_FULL_ACCESS=1).
- Gefährliche Aktionen (Löschen, Verschieben, Deinstallieren, Neustart, Registry, Systemeingriffe,
  neue Skills, Änderungen an Jarvis' eigenem Code) laufen nur mit deiner Freigabe (Telegram/HUD-Button).
- NOTAUS: /notaus in Telegram oder Button im HUD blockiert sofort jede weitere Aktion.

Ehrlich: Die Erkennung gefährlicher Shell-Befehle ist ein Sicherheitsnetz, kein Sandkasten.
"""
import asyncio
import hashlib
import os
import re
import shutil
import time
from pathlib import Path

from . import config, db

# ---------------------------------------------------------------- NOTAUS
def stopped() -> bool:
    return db.get_setting("notaus", "0") == "1"


def set_stop(on: bool):
    db.set_setting("notaus", "1" if on else "0")
    db.log_action("notaus", "AN" if on else "AUS")


# ---------------------------------------------------------------- Pfade
def resolve_path(p: str) -> Path:
    raw = os.path.expandvars(os.path.expanduser(str(p))).strip().strip('"')
    if not raw:
        raise ValueError("Leerer Pfad")
    candidate = Path(raw) if Path(raw).is_absolute() or raw.startswith(("\\\\", "//")) else config.WORKSPACE / raw
    path = candidate.resolve()
    if config.FULL_ACCESS:
        return path
    if config.IS_WINDOWS and raw.startswith(("\\\\", "//")):
        raise ValueError("UNC-/Netzwerkpfade sind im eingeschränkten Modus nicht erlaubt")
    base = config.WORKSPACE.resolve()
    try:
        path.relative_to(base)
    except ValueError as e:
        raise ValueError(f"Pfad außerhalb des Workspace nicht erlaubt (JARVIS_FULL_ACCESS=0): {base}") from e
    return path


def is_core_path(path: Path) -> bool:
    """Jarvis' eigener Programmcode (nicht data/) – Änderungen nur mit Freigabe."""
    app = config.APP_DIR.resolve()
    try:
        rel = path.resolve().relative_to(app)
    except ValueError:
        return False
    return not str(rel).replace("\\", "/").startswith("data")


def backup(path: Path) -> Path | None:
    """Kopie vor dem Überschreiben/Löschen nach data/backups/<Zeit>/…"""
    if not path.exists():
        return None
    dest_dir = config.BACKUP_DIR / time.strftime("%Y%m%d-%H%M%S")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / path.name
    if path.is_dir():
        shutil.copytree(path, dest, dirs_exist_ok=True)
    else:
        shutil.copy2(path, dest)
    return dest


# ---------------------------------------------------------------- Shell-Risiko
_DANGER = [
    r"\bRemove-\w+", r"\bClear-(Content|RecycleBin|Disk)\b", r"\bFormat-Volume\b", r"\bformat\s+[a-z]:",
    r"\bdiskpart\b", r"\b(Stop|Restart)-Computer\b", r"\bshutdown(\.exe)?\b", r"\bUninstall-\w+",
    r"\bmsiexec\b.*\s/x", r"\bwinget\s+uninstall\b", r"\breg(\.exe)?\s+(delete|add|import)\b",
    r"\bSet-ItemProperty\b.*\bHK(LM|CU)", r"\bNew-ItemProperty\b.*\bHKLM", r"\bbcdedit\b",
    r"\bSet-ExecutionPolicy\b", r"\bnet\s+(user|localgroup)\b", r"\bSet-MpPreference\b", r"\bvssadmin\b",
    r"\bwevtutil\s+cl\b", r"\bcipher\s+/w\b", r"\bschtasks\b.*\s/(delete|create)", r"\bRegister-ScheduledTask\b",
    r"\b(del|erase|rd|rmdir)\b\s", r"(^|[;&|\s])rm\s", r"\bMove-Item\b", r"\b(move|mv)\s",
    r"\bStop-Process\b", r"\btaskkill\b", r"\bStop-Service\b", r"\bSet-Service\b", r"\bDisable-\w+",
    r"-EncodedCommand\b", r"\s-enc\s", r"\b(iex|Invoke-Expression)\b",
    r"os\.(remove|unlink|rmdir)\(", r"shutil\.(rmtree|move)\(", r"\.unlink\(", r"\brmtree\b",
    r"\bRename-Item\b", r"\bSet-Acl\b", r"\btakeown\b", r"\bicacls\b",
]
_DANGER_RE = re.compile("|".join(_DANGER), re.IGNORECASE)


def shell_risk(command: str) -> str | None:
    m = _DANGER_RE.search(command or "")
    return m.group(0).strip() if m else None


# ---------------------------------------------------------------- Freigaben
def _hash(kind: str, summary: str) -> str:
    return hashlib.sha256(f"{kind}\n{summary}".encode("utf-8")).hexdigest()[:20]


def _interactive(ctx: dict | None) -> bool:
    ch = str((ctx or {}).get("channel", ""))
    return ch.startswith(("tg:", "hud"))


async def require_approval(kind: str, summary: str, details: str = "", ctx: dict | None = None) -> tuple[bool, str]:
    """True nur, wenn der Owner genau DIESE Aktion freigegeben hat. Jede Freigabe gilt genau einmal.

    Modelltext wie „approved=true“ hat keinerlei Wirkung – entscheidend ist nur die DB-Zeile,
    die ausschließlich über Telegram-Button, /ja oder HUD-Button gesetzt wird.
    """
    if stopped():
        return False, "NOTAUS ist aktiv – keine Aktionen, bis der Owner /weiter sendet."
    h = _hash(kind, summary)
    row = db.one("SELECT * FROM approvals WHERE action_hash=? AND used=0 AND status!='pending' ORDER BY id DESC", (h,))
    if row:
        db.ex("UPDATE approvals SET used=1 WHERE id=?", (row["id"],))
        if row["status"] == "approved":
            return True, f"Freigabe #{row['id']} liegt vor."
        return False, f"Owner hat #{row['id']} ABGELEHNT. {row['answer_note'] or ''} Nicht ausführen, anderen Weg wählen."
    pend = db.one("SELECT * FROM approvals WHERE action_hash=? AND status='pending' ORDER BY id DESC", (h,))
    if pend:
        aid = pend["id"]
    else:
        from .tools import notify  # spät importieren (Zirkelimport vermeiden)
        mission_id = (ctx or {}).get("mission_id")
        aid = db.ex("INSERT INTO approvals(mission_id,kind,question,details,created,action_hash) VALUES(?,?,?,?,?,?)",
                    (mission_id, kind, summary, details, db.now(), h))
        await notify(f"🛡 FREIGABE #{aid} nötig ({kind})\n{summary}" + (f"\n\n{details}" if details else ""), aid)
    if not _interactive(ctx):
        return False, (f"Wartet auf Freigabe #{aid}. Mach mit anderen Schritten weiter und versuche genau diese "
                       f"Aktion im nächsten Zyklus erneut.")
    for _ in range(max(1, config.APPROVAL_WAIT_SEC // 2)):
        await asyncio.sleep(2)
        if stopped():
            return False, "NOTAUS aktiviert."
        a = db.one("SELECT status, answer_note FROM approvals WHERE id=?", (aid,))
        if a and a["status"] != "pending":
            db.ex("UPDATE approvals SET used=1 WHERE id=?", (aid,))
            if a["status"] == "approved":
                return True, f"Freigabe #{aid} erteilt."
            return False, f"Owner hat #{aid} ABGELEHNT. {a['answer_note'] or ''}"
    return False, f"Keine Antwort auf Freigabe #{aid} in {config.APPROVAL_WAIT_SEC // 60} Min. Nicht ausgeführt."
