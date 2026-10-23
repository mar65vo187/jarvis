"""Offline sanity checks for the staged legal integration registry."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / "repositories.json").read_text(encoding="utf-8"))

EXPECTED = {
    "bundesrecht",
    "primamcp",
    "de-eli-mcp",
    "claude-fuer-deutsches-recht",
    "ai-skills-german-law",
    "legal-audit-de",
    "claude-for-legal",
    "legalrabbit-docx-mcp",
}

def validate() -> list[str]:
    errors: list[str] = []
    items = manifest.get("repositories")
    if not isinstance(items, list):
        return ["repositories must be a list"]
    ids = [item.get("id") for item in items]
    if set(ids) != EXPECTED:
        errors.append(f"repository ids differ: missing={sorted(EXPECTED-set(ids))}, extra={sorted(set(ids)-EXPECTED)}")
    if len(ids) != len(set(ids)):
        errors.append("repository ids must be unique")
    for item in items:
        if not str(item.get("url", "")).startswith("https://github.com/"):
            errors.append(f"{item.get('id')}: URL must be an HTTPS GitHub URL")
        if item.get("enabled") is not False:
            errors.append(f"{item.get('id')}: third-party integration must remain disabled until explicitly tested")
        if not item.get("license_status"):
            errors.append(f"{item.get('id')}: missing license status")
    gates = manifest.get("safety_gates", [])
    required = {
        "Never commit secrets or real client documents",
        "No remote transfer of confidential/personal contract data without explicit approval",
        "Require source URL and citation for each legal proposition",
    }
    if not required.issubset(set(gates)):
        errors.append("required safety gates are missing")
    return errors

if __name__ == "__main__":
    problems = validate()
    if problems:
        print("FAIL")
        print("\n".join(f"- {problem}" for problem in problems))
        raise SystemExit(1)
    print(f"PASS: {len(EXPECTED)} repositories registered; all integrations disabled pending review.")
