#!/usr/bin/env bash
# Holt die neueste Version aus GitHub und startet Jarvis neu. Aufruf: sudo /opt/jarvis/deploy/oracle/update.sh
set -euo pipefail
APP=/opt/jarvis
DATA=/var/lib/jarvis
ENVF="$DATA/.env"
BRANCH="${JARVIS_BRANCH:-main}"
[ "$(id -u)" = "0" ] || { echo "Bitte mit sudo ausführen."; exit 1; }
git -C "$APP" fetch --depth 1 origin "$BRANCH"
OLD=$(git -C "$APP" rev-parse HEAD)
git -C "$APP" reset --hard "origin/$BRANCH"
NEW=$(git -C "$APP" rev-parse HEAD)
chown -R root:root "$APP"; chmod -R go-w "$APP"
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"

# Adaptive Brain auf bestehenden Servern nachziehen. Werte werden nur gesetzt,
# wenn sie fehlen; bewusst konfigurierte Modellnamen bleiben erhalten.
setv_if_missing() {
  local k="$1" v="$2"
  touch "$ENVF"
  grep -qE "^$k=.+" "$ENVF" 2>/dev/null && return 0
  if grep -qE "^$k=" "$ENVF" 2>/dev/null; then
    python3 - "$ENVF" "$k" "$v" <<'PYENV'
import sys
f, k, v = sys.argv[1:]
lines = open(f, encoding="utf-8").read().splitlines()
open(f, "w", encoding="utf-8").write("\n".join(f"{k}={v}" if line.startswith(k + "=") else line for line in lines) + "\n")
PYENV
  else
    echo "$k=$v" >> "$ENVF"
  fi
}
RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
CPU_COUNT=$(nproc 2>/dev/null || echo 1)
MODEL=$(grep -E '^JARVIS_MODEL=' "$ENVF" 2>/dev/null | cut -d= -f2- || true)
[ -n "$MODEL" ] || MODEL="qwen3:4b-instruct-2507-q4_K_M"
FAST_MODEL=$(grep -E '^JARVIS_FAST_MODEL=.+' "$ENVF" 2>/dev/null | cut -d= -f2- || true)
if [ -z "$FAST_MODEL" ]; then
  if [ "$RAM_GB" -ge 20 ]; then FAST_MODEL="qwen3:4b-instruct-2507-q4_K_M"
  elif [ "$RAM_GB" -ge 5 ]; then FAST_MODEL="qwen3:1.7b"
  else FAST_MODEL="$MODEL"; fi
fi
DEEP_MODEL=$(grep -E '^JARVIS_DEEP_MODEL=.+' "$ENVF" 2>/dev/null | cut -d= -f2- || true)
[ -n "$DEEP_MODEL" ] || DEEP_MODEL="$MODEL"
setv_if_missing JARVIS_FAST_MODEL "$FAST_MODEL"
setv_if_missing JARVIS_DEEP_MODEL "$DEEP_MODEL"
setv_if_missing JARVIS_ADAPTIVE_THINK "1"
setv_if_missing JARVIS_PERFORMANCE_TUNE "1"
setv_if_missing JARVIS_PERFORMANCE_TUNE_INTERVAL_MIN "30"
setv_if_missing JARVIS_UPGRADE_AUTO "1"
setv_if_missing JARVIS_UPGRADE_INTERVAL_HOURS "6"
# Phase-2-Standard war 24 h. Nur genau diesen alten Default migrieren; eigene Werte bleiben unangetastet.
if grep -qE '^JARVIS_UPGRADE_INTERVAL_HOURS=24$' "$ENVF" 2>/dev/null; then
  python3 - "$ENVF" <<'PYENV'
import sys
f = sys.argv[1]
lines = open(f, encoding="utf-8").read().splitlines()
open(f, "w", encoding="utf-8").write("\n".join("JARVIS_UPGRADE_INTERVAL_HOURS=6" if line == "JARVIS_UPGRADE_INTERVAL_HOURS=24" else line for line in lines) + "\n")
PYENV
fi
chown jarvis:jarvis "$ENVF"; chmod 600 "$ENVF"

if command -v ollama >/dev/null 2>&1; then
  if [ "$RAM_GB" -ge 20 ] && [ "$CPU_COUNT" -ge 4 ]; then OLLAMA_PARALLEL=2; OLLAMA_LOADED=2
  else OLLAMA_PARALLEL=1; OLLAMA_LOADED=1; fi
  mkdir -p /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/jarvis.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_NUM_PARALLEL=$OLLAMA_PARALLEL"
Environment="OLLAMA_MAX_LOADED_MODELS=$OLLAMA_LOADED"
Environment="OLLAMA_KEEP_ALIVE=-1"
EOF
  systemctl daemon-reload
  systemctl restart ollama || true
  for i in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
  for M in "$FAST_MODEL" "$DEEP_MODEL"; do
    [ -n "$M" ] || continue
    if ! ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -Fxq "$M"; then
      echo "Lade Adaptive-Brain-Modell $M …"
      ollama pull "$M" || echo "WARNUNG: $M konnte nicht geladen werden; Jarvis fällt auf $MODEL zurück."
    fi
  done
fi

systemctl restart jarvis
for i in $(seq 1 40); do curl -fs http://127.0.0.1:8765/health >/dev/null && break; sleep 1; done
if curl -fs http://127.0.0.1:8765/health >/dev/null; then
  echo "Jarvis aktualisiert: ${OLD:0:7} → ${NEW:0:7} und läuft."
else
  echo "FEHLER: Jarvis startet nach dem Update nicht – setze auf ${OLD:0:7} zurück."
  git -C "$APP" reset --hard "$OLD"
  systemctl restart jarvis
  journalctl -u jarvis -n 40 --no-pager
  exit 1
fi
