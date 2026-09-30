"""Selbstentwicklung: Jarvis schreibt sich eigene Werkzeuge (Skills) in Python.

Ablauf (im Code erzwungen):
1. Jarvis schreibt Code → Syntax- und Strukturprüfung (DESCRIPTION, PARAMETERS, async def run).
2. Neue Version wird als „pending“ gespeichert → Freigabe-Anfrage an Owner (Telegram/HUD) mit Code-Auszug.
3. Nur nach Freigabe: Probe-Import. Klappt der, wird die Version aktiv; die alte bleibt als Rückfall.
4. skill_rollback setzt auf die Vorversion zurück oder deaktiviert.

Skills laufen mit denselben Rechten wie Jarvis – deshalb gibt es sie nur mit Freigabe.
"""
import ast
import asyncio
import importlib.util
import inspect
import re
import sys

from . import config, db, guard

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,40}$")
_loaded: dict[str, object] = {}  # "name:version" -> Modul


def _file(name: str, version: int):
    d = config.SKILLS_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    return d / f"v{version}.py"


def _check_code(code: str) -> str | None:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return f"Syntaxfehler Zeile {e.lineno}: {e.msg}"
    names = set()
    has_run = False
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == "run":
            has_run = True
    missing = [n for n in ("DESCRIPTION", "PARAMETERS") if n not in names]
    if missing or not has_run:
        return ("Skill-Code muss auf oberster Ebene DESCRIPTION = '…', PARAMETERS = {JSON-Schema} und "
                f"`async def run(**kwargs) -> str` definieren. Fehlt: {', '.join(missing + ([] if has_run else ['run']))}")
    return None


def _load(name: str, version: int):
    key = f"{name}:{version}"
    if key in _loaded:
        return _loaded[key]
    path = _file(name, version)
    spec = importlib.util.spec_from_file_location(f"jarvis_skill_{name}_v{version}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    if not isinstance(getattr(mod, "PARAMETERS", None), dict) or not callable(getattr(mod, "run", None)):
        raise ValueError("PARAMETERS muss ein dict sein und run eine Funktion.")
    _loaded[key] = mod
    return mod


def _builtin_names() -> set:
    from .tools import HANDLERS
    return set(HANDLERS)


def _active() -> list[dict]:
    return db.q("SELECT * FROM skills WHERE status='active' ORDER BY name")


async def create(name: str, code: str, reason: str, ctx: dict | None) -> str:
    name = (name or "").strip().lower()
    if not _NAME_RE.match(name):
        return "Ungültiger Name: nur kleinbuchstaben, ziffern, _ (3–41 Zeichen, Buchstabe zuerst)."
    if name in _builtin_names():
        return f"„{name}“ ist ein eingebautes Werkzeug. Anderen Namen wählen."
    err = _check_code(code)
    if err:
        return err
    same = db.one("SELECT * FROM skills WHERE name=? AND status='pending' ORDER BY version DESC", (name,))
    if same and _file(name, same["version"]).read_text(encoding="utf-8") == code:
        row = same
    else:
        last = db.one("SELECT MAX(version) v FROM skills WHERE name=?", (name,))
        version = (last["v"] or 0) + 1 if last else 1
        _file(name, version).write_text(code, encoding="utf-8")
        sid = db.ex("INSERT INTO skills(name,version,description,status,file,created) VALUES(?,?,?,?,?,?)",
                    (name, version, reason[:500], "pending", str(_file(name, version)), db.now()))
        row = db.one("SELECT * FROM skills WHERE id=?", (sid,))
    version = row["version"]
    ok, msg = await guard.require_approval(
        "skill", f"Neuen Skill aktivieren: {name} v{version}\nZweck: {reason[:300]}",
        f"Code (Auszug):\n{code[:1800]}", ctx=ctx)
    if not ok:
        return f"Skill {name} v{version} gespeichert, aber NICHT aktiv. {msg}"
    try:
        mod = _load(name, version)
    except Exception as e:
        db.ex("UPDATE skills SET status='failed' WHERE id=?", (row["id"],))
        return f"Probe-Import fehlgeschlagen ({type(e).__name__}: {e}). Code korrigieren und neu anlegen."
    db.ex("UPDATE skills SET status='superseded' WHERE name=? AND status='active'", (name,))
    db.ex("UPDATE skills SET status='active' WHERE id=?", (row["id"],))
    db.log_action("skill", f"{name} v{version} aktiv")
    return f"Skill „{name}“ v{version} ist aktiv: {getattr(mod, 'DESCRIPTION', '')}"


def rollback(name: str, disable: bool = False) -> str:
    cur = db.one("SELECT * FROM skills WHERE name=? AND status='active'", (name,))
    if disable:
        db.ex("UPDATE skills SET status='disabled' WHERE name=? AND status='active'", (name,))
        return f"Skill {name} deaktiviert." if cur else f"Kein aktiver Skill {name}."
    prev = db.one("SELECT * FROM skills WHERE name=? AND status='superseded' ORDER BY version DESC", (name,))
    if not prev:
        return f"Keine Vorversion von {name} vorhanden."
    if cur:
        db.ex("UPDATE skills SET status='disabled' WHERE id=?", (cur["id"],))
    db.ex("UPDATE skills SET status='active' WHERE id=?", (prev["id"],))
    db.log_action("skill", f"{name} zurück auf v{prev['version']}")
    return f"Skill {name} zurück auf v{prev['version']}."


def describe() -> str:
    rows = db.q("SELECT name,version,status,description FROM skills ORDER BY name, version DESC")
    return "\n".join(f"{r['name']} v{r['version']} [{r['status']}] – {r['description']}" for r in rows) \
        or "Noch keine eigenen Skills."


def schemas() -> list[dict]:
    out = []
    for r in _active():
        try:
            mod = _load(r["name"], r["version"])
        except Exception as e:
            print(f"Skill {r['name']} v{r['version']} lädt nicht: {e}")
            continue
        out.append({"name": r["name"], "description": "[Eigener Skill] " + str(getattr(mod, "DESCRIPTION", "")),
                    "input_schema": mod.PARAMETERS})
    return out


def handler(name: str):
    r = db.one("SELECT * FROM skills WHERE name=? AND status='active'", (name,))
    if not r:
        return None
    mod = _load(r["name"], r["version"])

    async def _run(**kwargs):
        kwargs = {k: v for k, v in kwargs.items() if not k.startswith("_")}
        fn = mod.run
        res = await fn(**kwargs) if inspect.iscoroutinefunction(fn) else await asyncio.to_thread(fn, **kwargs)
        db.log_action("skill", f"{name}: ausgeführt")
        return res if isinstance(res, str) else str(res)
    return _run
