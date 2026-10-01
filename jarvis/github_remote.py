"""Stateless GitHub Actions entrypoint for /jarvis issue commands.

No PC/file/action tools are exposed here. It is an advisory remote brain only.
"""
import asyncio
import os

from . import agents, config, model_pool, privacy

PUBLIC_WARNING = ("JARVIS Remote: Abgelehnt. GitHub-Issues in diesem Repo sind öffentlich und die Antwort käme "
                  "von einer Cloud-KI. Private Inhalte gehören nur zu deinem eigenen Jarvis (PC/Oracle über "
                  "Tailscale). Gefunden: {found}.")


async def run(task: str) -> str:
    task = (task or "").strip()
    if task.lower().startswith("/jarvis"):
        task = task[len("/jarvis"):].strip()
    if not task:
        return "JARVIS: Kein Auftrag angegeben."
    # Einbahnstraße: hier nie private Inhalte verarbeiten (öffentlich + Cloud).
    found = (["/privat"] if privacy.explicit_private(task) else []) + privacy.sensitive_findings(task)
    if found:
        return PUBLIC_WARNING.format(found=", ".join(dict.fromkeys(found)))
    rows = await model_pool.catalog()
    row = model_pool.best(rows, free_only=False)
    if not row:
        return ("JARVIS Remote: Kein Cloud-Modell verfügbar. Hinterlege im Repository-Secret "
                "XKIRO_API_KEY oder HF_TOKEN.")
    council = ""
    try:
        council = await agents.council(task)
    except Exception:
        council = ""
    messages = [
        {"role": "system", "content":
         "Du bist JARVIS Remote in GitHub Actions. Du hast KEINEN Zugriff auf Marvins PC und keine Side-Effect-Werkzeuge. "
         "Behaupte niemals, Dateien oder externe Konten geändert zu haben. Liefere eine präzise, direkt nutzbare Antwort. "
         + (("\n\nSpezialistenrat:\n" + council[:18000]) if council else "")},
        {"role": "user", "content": task[:20000]},
    ]
    out = await model_pool.call(row, messages, max_tokens=2500, reasoning_effort="high")
    text = ((out.get("message") or {}).get("content") or "").strip()
    return text or "JARVIS Remote hat keinen Antworttext geliefert."


if __name__ == "__main__":
    print(asyncio.run(run(os.environ.get("JARVIS_REMOTE_TASK", ""))))
