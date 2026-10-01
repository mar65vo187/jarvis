#!/usr/bin/env bash
# Verschlüsseltes Backup von Jarvis' Daten (Gedächtnis, Wissen, Skills, Verlauf).
# Der Datenschlüssel jarvis.key wird absichtlich NICHT mitgesichert – er gehört getrennt aufbewahrt
# (Passwort-Manager). Ohne Schlüssel sind private Inhalte im Backup nicht lesbar.
# Aufruf: sudo /opt/jarvis/deploy/oracle/backup.sh   (läuft zusätzlich täglich per systemd-Timer)
set -euo pipefail
DATA=/var/lib/jarvis
DEST=/var/backups/jarvis
PASSFILE=/root/jarvis-backup.pass
KEEP=14
[ "$(id -u)" = "0" ] || { echo "Bitte mit sudo ausführen."; exit 1; }
mkdir -p "$DEST"; chmod 700 "$DEST"
if [ ! -s "$PASSFILE" ]; then
  openssl rand -base64 32 > "$PASSFILE"; chmod 600 "$PASSFILE"
fi
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/jarvis-$STAMP.tar.gz.enc"
# SQLite konsistent sichern (WAL) und dann alles verschlüsseln
sqlite3 "$DATA/jarvis.db" ".backup '$DATA/jarvis.db.bak'" 2>/dev/null || cp "$DATA/jarvis.db" "$DATA/jarvis.db.bak"
tar -C "$DATA" --exclude=jarvis.key --exclude=jarvis.db --exclude=jarvis.db-wal --exclude=jarvis.db-shm \
    --exclude=.env -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE" -out "$OUT"
rm -f "$DATA/jarvis.db.bak"
chmod 600 "$OUT"
ls -1t "$DEST"/jarvis-*.tar.gz.enc | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Backup: $OUT"
echo "Wiederherstellen: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$PASSFILE -in <datei> | tar -xzf - -C <ziel>"
