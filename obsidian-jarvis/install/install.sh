#!/usr/bin/env bash
# Jarvis AI fuer Obsidian - Installation unter macOS/Linux.
# Aufruf:  ./install.sh /pfad/zu/deinem/Vault
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUELLE="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_ID="jarvis-ai"

echo "===================================================="
echo "  Jarvis AI fuer Obsidian - Einrichtung"
echo "===================================================="
echo

for datei in main.js manifest.json styles.css; do
  if [ ! -f "$QUELLE/$datei" ]; then
    echo "FEHLER: $datei fehlt in $QUELLE"
    echo "Bitte die ZIP vollstaendig entpacken (nicht direkt daraus starten)."
    exit 1
  fi
done

VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  # Vorschlaege aus der Obsidian-Konfiguration lesen
  case "$(uname -s)" in
    Darwin) CONFIG="$HOME/Library/Application Support/obsidian/obsidian.json" ;;
    *)      CONFIG="$HOME/.config/obsidian/obsidian.json" ;;
  esac
  if [ -f "$CONFIG" ]; then
    echo "Bekannte Vaults:"
    python3 - "$CONFIG" <<'PY' || true
import json,sys,os
try:
    data=json.load(open(sys.argv[1]))
    for i,(k,v) in enumerate(data.get("vaults",{}).items(),1):
        p=v.get("path","")
        if p and os.path.isdir(p):
            print(f"  [{i}] {p}")
except Exception:
    pass
PY
    echo
  fi
  printf "Pfad zu deinem Vault: "
  read -r VAULT
  VAULT="${VAULT%\"}"; VAULT="${VAULT#\"}"
fi

VAULT="${VAULT%/}"
if [ ! -d "$VAULT" ]; then
  echo "FEHLER: Ordner existiert nicht: $VAULT"
  exit 1
fi

ZIEL="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$ZIEL"

if [ -f "$ZIEL/main.js" ]; then
  BACKUP="$HOME/.jarvis-ai-backups/$(date +%Y-%m-%d_%H-%M-%S)"
  mkdir -p "$BACKUP"
  cp -f "$ZIEL/main.js" "$ZIEL/manifest.json" "$ZIEL/styles.css" "$BACKUP/" 2>/dev/null || true
  echo "Alte Dateien gesichert: $BACKUP"
fi

cp -f "$QUELLE/main.js" "$QUELLE/manifest.json" "$QUELLE/styles.css" "$ZIEL/"
echo
echo "Installiert nach: $ZIEL"
echo
if command -v ollama >/dev/null 2>&1; then
  if curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Ollama laeuft."
    if ! curl -s http://127.0.0.1:11434/api/tags | grep -q 'nomic-embed-text'; then
      echo "Tipp fuer bessere Suche: ollama pull nomic-embed-text"
    fi
  else
    echo "Ollama gefunden, laeuft aber nicht. Bitte starten (ollama serve)."
  fi
else
  echo "Ollama ist nicht installiert - lokale Modelle brauchen es: https://ollama.com/download"
fi
cat <<'TEXT'

Naechste Schritte in Obsidian:
  1. Obsidian neu laden (Strg/Cmd+R).
  2. Einstellungen -> Community-Plugins -> "Jarvis AI (lokal + Top-Cloud)" aktivieren.
  3. Strg/Cmd+P -> "Jarvis: Chat oeffnen".
  4. In den Jarvis-Einstellungen Modell waehlen und optional Cloud-Schluessel eintragen.
TEXT
