#!/usr/bin/env bash
# Holt die neueste Version aus GitHub und startet Jarvis neu. Aufruf: sudo /opt/jarvis/deploy/oracle/update.sh
set -euo pipefail
APP=/opt/jarvis
BRANCH="${JARVIS_BRANCH:-main}"
[ "$(id -u)" = "0" ] || { echo "Bitte mit sudo ausführen."; exit 1; }
git -C "$APP" fetch --depth 1 origin "$BRANCH"
OLD=$(git -C "$APP" rev-parse HEAD)
git -C "$APP" reset --hard "origin/$BRANCH"
NEW=$(git -C "$APP" rev-parse HEAD)
chown -R root:root "$APP"; chmod -R go-w "$APP"
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
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
