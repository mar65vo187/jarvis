"""SQLite-Gedächtnis: Chats, Wissen, Missionen, Freigaben, Zeitpläne, Kosten."""
import json
import sqlite3
import threading
import time
from datetime import datetime

from . import config

_lock = threading.RLock()
_conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

_conn.executescript(
    """
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, channel TEXT, role TEXT, content TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS memory(
  id INTEGER PRIMARY KEY, topic TEXT, content TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS missions(
  id INTEGER PRIMARY KEY, title TEXT, goal TEXT, status TEXT DEFAULT 'active',
  plan TEXT DEFAULT '', next_step TEXT DEFAULT '', target_value REAL, current_value REAL DEFAULT 0,
  unit TEXT DEFAULT '', next_run REAL, cycles INTEGER DEFAULT 0, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS mission_log(
  id INTEGER PRIMARY KEY, mission_id INTEGER, ts REAL, entry TEXT);
CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY, mission_id INTEGER, kind TEXT, question TEXT, details TEXT,
  status TEXT DEFAULT 'pending', answer_note TEXT DEFAULT '', created REAL, answered REAL);
CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY, description TEXT, prompt TEXT, interval_min INTEGER,
  daily_time TEXT, next_run REAL, active INTEGER DEFAULT 1, created REAL);
CREATE TABLE IF NOT EXISTS usage(
  day TEXT PRIMARY KEY, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  searches INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS actions(
  id INTEGER PRIMARY KEY, ts REAL, kind TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS knowledge(
  id INTEGER PRIMARY KEY, topic TEXT, question TEXT, answer TEXT, source TEXT, ts REAL, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS skills(
  id INTEGER PRIMARY KEY, name TEXT, version INTEGER, description TEXT, status TEXT DEFAULT 'pending',
  file TEXT, created REAL);
CREATE TABLE IF NOT EXISTS model_metrics(
  source TEXT, model TEXT, successes INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
  total_latency_ms INTEGER DEFAULT 0, last_used REAL DEFAULT 0,
  PRIMARY KEY(source,model));
CREATE TABLE IF NOT EXISTS agent_profiles(
  id INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT, mission TEXT, vendors_json TEXT DEFAULT '[]',
  reasoning INTEGER DEFAULT 1, web_search INTEGER DEFAULT 0, task_type TEXT DEFAULT 'general',
  parent_key TEXT DEFAULT '', generation INTEGER DEFAULT 1, score REAL DEFAULT 0,
  status TEXT DEFAULT 'active', created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS upgrade_runs(
  id INTEGER PRIMARY KEY, ts REAL, focus TEXT, status TEXT, candidate_key TEXT DEFAULT '',
  score REAL DEFAULT 0, details TEXT DEFAULT '');
"""
)
# Migrationen für bestehende Datenbanken (älterer Stand) – idempotent.
for _sql in ("ALTER TABLE approvals ADD COLUMN action_hash TEXT DEFAULT ''",
             "ALTER TABLE approvals ADD COLUMN used INTEGER DEFAULT 0",
             # Privatsphäre: bestehende Einträge gelten vorsichtshalber als privat
             "ALTER TABLE messages ADD COLUMN private INTEGER DEFAULT 0",
             "ALTER TABLE memory ADD COLUMN private INTEGER DEFAULT 1",
             "ALTER TABLE missions ADD COLUMN private INTEGER DEFAULT 0"):
    try:
        _conn.execute(_sql)
    except sqlite3.OperationalError:
        pass
_conn.commit()


def q(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql: str, args: tuple = ()) -> int:
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.lastrowid


def now() -> float:
    return time.time()


def today() -> str:
    return datetime.now(config.TIMEZONE).strftime("%Y-%m-%d")


def fmt_ts(ts: float | None) -> str:
    if not ts:
        return "-"
    return datetime.fromtimestamp(ts, config.TIMEZONE).strftime("%d.%m. %H:%M")


# ---------- Chatverlauf ----------
def add_message(channel: str, role: str, content: str, private: bool = False):
    """Private Nachrichten werden verschlüsselt gespeichert (Schlüssel getrennt von der Datenbank)."""
    if private:
        from . import privacy
        content = privacy.encrypt(content)
    ex("INSERT INTO messages(channel,role,content,ts,private) VALUES(?,?,?,?,?)",
       (channel, role, content, now(), 1 if private else 0))


def history(channel: str, turns: int) -> list[dict]:
    from . import privacy
    rows = q(
        "SELECT role,content,private FROM messages WHERE channel=? ORDER BY id DESC LIMIT ?",
        (channel, turns * 2),
    )
    rows.reverse()
    for r in rows:
        if r.get("private"):
            r["content"] = privacy.decrypt(r["content"])
    # Anthropic verlangt: Start mit user, abwechselnde Rollen
    msgs: list[dict] = []
    for r in rows:
        if msgs and msgs[-1]["role"] == r["role"]:
            msgs[-1]["content"] += "\n\n" + r["content"]
            msgs[-1]["private"] = msgs[-1]["private"] or bool(r.get("private"))
        else:
            msgs.append({"role": r["role"], "content": r["content"], "private": bool(r.get("private"))})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def clear_history(channel: str):
    ex("DELETE FROM messages WHERE channel=?", (channel,))


# ---------- Kosten ----------
def add_usage(inp: int, out: int, searches: int, cost: float):
    d = today()
    ex("INSERT OR IGNORE INTO usage(day) VALUES(?)", (d,))
    ex(
        "UPDATE usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, "
        "searches=searches+?, cost_usd=cost_usd+? WHERE day=?",
        (inp, out, searches, cost, d),
    )


def cost_today() -> float:
    r = one("SELECT cost_usd FROM usage WHERE day=?", (today(),))
    return r["cost_usd"] if r else 0.0


# ---------- Aktionsprotokoll ----------
def log_action(kind: str, summary: str):
    ex("INSERT INTO actions(ts,kind,summary) VALUES(?,?,?)", (now(), kind, summary[:1000]))


def to_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


# ---------- Einstellungen ----------
def get_setting(key: str, default: str = "") -> str:
    r = one("SELECT value FROM settings WHERE key=?", (key,))
    return r["value"] if r else default


def set_setting(key: str, value: str):
    ex("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, value))
