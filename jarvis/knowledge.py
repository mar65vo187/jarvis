"""Jarvis' eigener Wissensspeicher – so wird SEINE KI mit der Zeit stärker.

Was Lehrer-KIs (xKiro/Claude/…) auf allgemeine Fragen antworten und was öffentlich recherchiert wurde,
landet hier dauerhaft. Bei neuen Aufgaben bekommt Jarvis die passendsten Einträge mitgeliefert – auch die
lokale KI, die damit private Aufgaben besser lösen kann, ohne dass Daten hinausgehen (Wissen nur HEREIN).
Einträge mit persönlichen Daten werden nie gespeichert.
"""
import re

from . import db, privacy

_STOP = set("der die das und oder aber ein eine einer eines einem den dem des ist sind war wie was wer wo wann "
            "warum mit für von zu im in am an auf aus bei nach über unter vor ich du er sie es wir ihr mir mich dir "
            "dich mein dein bitte kannst kann soll sollte wird werden hat haben nicht kein keine noch auch nur so "
            "the and for with what how why".split())


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-zäöüß0-9]{3,}", (text or "").lower()) if w not in _STOP]


def learn(question: str, answer: str, source: str, topic: str = "") -> int | None:
    question, answer = (question or "").strip(), (answer or "").strip()
    if len(answer) < 40 or privacy.sensitive_findings(question + "\n" + answer):
        return None
    dup = db.one("SELECT id FROM knowledge WHERE question=?", (question[:2000],))
    if dup:
        db.ex("UPDATE knowledge SET answer=?, source=?, ts=? WHERE id=?", (answer[:12000], source, db.now(), dup["id"]))
        return dup["id"]
    topic = topic or " ".join(_words(question)[:4])
    return db.ex("INSERT INTO knowledge(topic,question,answer,source,ts) VALUES(?,?,?,?,?)",
                 (topic[:120], question[:2000], answer[:12000], source[:60], db.now()))


def lookup(text: str, limit: int = 3) -> list[dict]:
    words = set(_words(text))
    if not words:
        return []
    rows = db.q("SELECT id,topic,question,answer,source FROM knowledge ORDER BY id DESC LIMIT 2000")
    scored = []
    for r in rows:
        hay = set(_words(r["topic"] + " " + r["question"]))
        score = len(words & hay)
        if score >= max(1, min(2, len(words) // 3)):
            scored.append((score, r))
    scored.sort(key=lambda x: (-x[0], -x[1]["id"]))
    hits = [r for _, r in scored[:limit]]
    for r in hits:
        db.ex("UPDATE knowledge SET uses=uses+1 WHERE id=?", (r["id"],))
    return hits


def context_block(text: str, limit: int = 3, max_chars: int = 4000) -> str:
    hits = lookup(text, limit)
    if not hits:
        return ""
    parts, used = [], 0
    for h in hits:
        piece = f"- Frage: {h['question'][:300]}\n  Gelerntes Wissen (von {h['source']}): {h['answer'][:1500]}"
        if used + len(piece) > max_chars:
            break
        parts.append(piece)
        used += len(piece)
    return "EIGENES WISSEN (früher von Lehrer-KIs gelernt – nutzen, wenn passend):\n" + "\n".join(parts)


def stats() -> dict:
    r = db.one("SELECT COUNT(*) c, COALESCE(SUM(uses),0) u FROM knowledge") or {"c": 0, "u": 0}
    return {"entries": r["c"], "uses": r["u"]}
