"""Privatsphäre als „Einbahnstraße“ (Datendiode):

  Wissen darf HEREIN  – Antworten anderer KIs und öffentliche Webinhalte landen in Jarvis' eigenem Wissen.
  Private Daten nie HINAUS – sie werden nur von der lokalen KI verarbeitet und gehen nur an den Owner.

Durchgesetzt im Code (nicht im Prompt):
1. Markierung: Sobald ein Werkzeug private Daten liefert (Dateien, Mails, Bildschirm, Gedächtnis, Chats …),
   gilt die Aufgabe – und das ganze Gespräch – als privat. Private Nachrichten werden verschlüsselt gespeichert.
2. Gehirn: Private Aufgaben laufen ausschließlich über die lokale KI. Ist sie nicht bereit, wird abgebrochen
   statt an eine Cloud zu senden. Im Modus „strikt“ gilt das für ALLES.
3. Ausgangsschleuse: Werkzeuge, die Daten nach draußen schicken, prüfen in privaten Aufgaben auf
   persönliche Daten bzw. brauchen die Freigabe des Owners mit genauer Vorschau.
4. Lehrer: Cloud-KIs bekommen nur einzelne, allgemeine Fragen ohne Verlauf und ohne persönliche Daten.
"""
import os
import re
from pathlib import Path

from . import config

# Werkzeuge, deren ERGEBNIS private Daten enthält → Aufgabe wird privat
PRIVATE_SOURCE_TOOLS = {
    "read_file", "list_dir", "search_files", "recall", "read_inbox", "clipboard", "screenshot", "windows",
    "system_status", "shell", "mission_log", "stripe_revenue", "get_secret",
}
# Werkzeuge, mit denen Daten Jarvis verlassen
OUTBOUND_TOOLS = {"web_search", "fetch_url", "http_request", "send_email", "n8n", "publish_page",
                  "stripe_payment_link", "ask_teacher"}
# Davon: Versand an Dritte → in privaten Aufgaben IMMER Freigabe mit Vorschau
OUTBOUND_NEEDS_APPROVAL = {"http_request", "send_email", "n8n", "publish_page", "stripe_payment_link"}

_PRIVATE_PREFIX = re.compile(r"^\s*(/privat\b|privat:)", re.I)
_SENSITIVE = [
    ("E-Mail-Adresse", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b")),
    ("Kartennummer", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("Passwort/Schlüssel", re.compile(r"(passwort|password|kennwort|api[_ -]?key|token|secret)\s*[:=]", re.I)),
    ("Schlüssel", re.compile(r"\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})\b")),
    ("Adresse", re.compile(r"\b[A-ZÄÖÜ][a-zäöüß]+(straße|str\.|weg|allee|platz|gasse)\s+\d+", re.I)),
]


def explicit_private(text: str) -> bool:
    return bool(_PRIVATE_PREFIX.match(text or ""))


def strip_prefix(text: str) -> str:
    return _PRIVATE_PREFIX.sub("", text or "", count=1).strip()


def sensitive_findings(text: str) -> list[str]:
    """Persönliche Daten im Text (für Ausgangsschleuse und Lehrer-Fragen)."""
    found = []
    if _has_phone(text or ""):
        found.append("Telefonnummer")
    for label, rx in _SENSITIVE:
        if rx.search(text or ""):
            found.append(label)
    for name in _private_names():
        if re.search(rf"\b{re.escape(name)}\b", text or "", re.I):
            found.append(f"Name aus privatem Gedächtnis ({name})")
            break
    return found


_PHONE = re.compile(r"(?<![\w+])(\+\d{1,3}|0)[\d /()-]{6,}\d")


def _has_phone(text: str) -> bool:
    for m in _PHONE.finditer(text):
        if len(re.sub(r"\D", "", m.group(0))) >= 9:
            return True
    return False


def _private_names() -> set[str]:
    """Eigennamen aus privaten Gedächtnis-Einträgen (Kontakte usw.) – dürfen nie zum Lehrer."""
    from . import db
    names = set()
    for r in db.q("SELECT content FROM memory WHERE private=1 ORDER BY id DESC LIMIT 300"):
        text = decrypt(r["content"])
        for w in re.findall(r"\b[A-ZÄÖÜ][a-zäöüß]{2,}\b", text):
            if w.lower() not in _COMMON:
                names.add(w)
    return names


_COMMON = {w.lower() for w in (
    "Der Die Das Ein Eine Und Oder Aber Sir Marvin Jarvis Kunde Kunden Termin Montag Dienstag Mittwoch Donnerstag "
    "Freitag Samstag Sonntag Januar Februar März April Mai Juni Juli August September Oktober November Dezember "
    "Heute Morgen Ich Er Sie Wir Ihr Mein Meine Bitte Danke Hallo TarifWerk Wiesbaden Deutschland").split()}


def must_stay_local(messages: list[dict] | None = None, ctx: dict | None = None) -> bool:
    if config.PRIVACY == "strikt":
        return True
    if ctx and ctx.get("private"):
        return True
    return any(m.get("private") for m in (messages or []))


# ------------------------------------------------------------------ Verschlüsselung privater Inhalte
_PREFIX = "enc:v1:"
_fernet = None


def _key_file() -> Path:
    return config.DATA_DIR / "jarvis.key"


def _get_fernet():
    global _fernet
    if _fernet is not None:
        return _fernet
    from cryptography.fernet import Fernet
    env = os.environ.get("JARVIS_DATA_KEY", "").strip()
    if env:
        key = env.encode()
    else:
        kf = _key_file()
        if kf.exists():
            key = kf.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            kf.write_bytes(key)
            try:
                os.chmod(kf, 0o600)
            except OSError:
                pass
    _fernet = Fernet(key)
    return _fernet


def encrypt(text: str) -> str:
    if text is None or str(text).startswith(_PREFIX):
        return text
    return _PREFIX + _get_fernet().encrypt(str(text).encode("utf-8")).decode("ascii")


def decrypt(value: str) -> str:
    if not isinstance(value, str) or not value.startswith(_PREFIX):
        return value
    try:
        return _get_fernet().decrypt(value[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except Exception:
        return "[verschlüsselt – Schlüssel fehlt oder falsch]"


def key_fingerprint() -> str:
    import hashlib
    raw = os.environ.get("JARVIS_DATA_KEY", "").encode() or (_key_file().read_bytes() if _key_file().exists() else b"")
    return hashlib.sha256(raw).hexdigest()[:12] if raw else ""


def reset_cache():
    global _fernet
    _fernet = None

