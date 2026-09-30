"""Build a distributable archive containing tracked source, never user data/keys."""
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
files = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
DEST = ROOT / "dist" / "JARVIS_READY.zip"
DEST.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(DEST, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        if not name or name.startswith((".github/", "tests/")):
            continue
        if name in (".env",) or name.startswith(("data/", ".venv/")):
            raise RuntimeError(f"Private Datei im Git-Index: {name}")
        archive.write(ROOT / name, f"Jarvis/{name}")
print(DEST)
