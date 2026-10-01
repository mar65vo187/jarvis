#!/usr/bin/env bash
# =====================================================================================
#  J.A.R.V.I.S. ONLINE – Installation auf einem Oracle-Cloud-Server (Ubuntu 22.04/24.04, ARM oder x86)
#
#  Aufruf (als root bzw. mit sudo), mehrfach ausführbar (= Update/Reparatur):
#     sudo TELEGRAM_BOT_TOKEN="123:ABC" JARVIS_PASSWORD="geheim" bash install.sh
#  Optional: XKIRO_API_KEY / ANTHROPIC_API_KEY  (Cloud-Gehirn; lokale KI bleibt als Ersatz)
#            TS_AUTHKEY="tskey-auth-…"  → Zugang NUR über dein privates Tailscale-Netz (empfohlen, kein offener Port)
#            JARVIS_PRIVACY="strikt" (Standard) oder "smart"
#            JARVIS_DOMAIN="jarvis.tarifwerk.eu"  (nur ohne Tailscale; sonst automatisch <IP>.sslip.io)
#            JARVIS_MODEL="qwen3:4b-instruct-2507-q4_K_M"   TELEGRAM_OWNER_ID="123456789"
#            JARVIS_REPO="https://github.com/mar65vo187/jarvis"  JARVIS_BRANCH="main"
#
#  Ergebnis: Ollama (lokale KI auf dem Server) + Jarvis (systemd) + HTTPS (Caddy) + Firewall + Swap.
# =====================================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO="${JARVIS_REPO:-https://github.com/mar65vo187/jarvis}"
BRANCH="${JARVIS_BRANCH:-main}"
APP=/opt/jarvis
DATA=/var/lib/jarvis
ENVF="$DATA/.env"
LOG=/var/log/jarvis-install.log
C='\033[1;36m'; Y='\033[1;33m'; N='\033[0m'
say()  { echo -e "${C}▶ $*${N}" | tee -a "$LOG"; }
warn() { echo -e "${Y}! $*${N}" | tee -a "$LOG"; }

[ "$(id -u)" = "0" ] || { echo "Bitte mit sudo ausführen."; exit 1; }
touch "$LOG"; chmod 600 "$LOG"

# ---------------------------------------------------------------- Pakete
say "Systempakete …"
apt-get update -y >>"$LOG" 2>&1
apt-get install -y git curl ca-certificates gnupg python3 python3-venv python3-pip openssl sqlite3 >>"$LOG" 2>&1
apt-get install -y iptables-persistent >>"$LOG" 2>&1 || warn "iptables-persistent nicht verfügbar – Firewall-Regeln nach Neustart ggf. neu setzen."
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y caddy >>"$LOG" 2>&1 || {
    say "Caddy aus dem offiziellen Caddy-Paketarchiv …"
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y >>"$LOG" 2>&1 && apt-get install -y caddy >>"$LOG" 2>&1
  }
fi

# ---------------------------------------------------------------- Swap (Sicherheitsnetz bei knappem RAM)
if ! swapon --show | grep -q /swapfile; then
  say "Lege 4 GB Swap an …"
  if { [ -f /swapfile ] || fallocate -l 4G /swapfile; } && chmod 600 /swapfile && mkswap /swapfile >>"$LOG" 2>&1 \
     && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    warn "Swap konnte nicht angelegt werden – Jarvis läuft trotzdem."
  fi
fi

# ---------------------------------------------------------------- Benutzer & Code
id jarvis >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /bin/bash jarvis
mkdir -p "$DATA"; chown jarvis:jarvis "$DATA"; chmod 750 "$DATA"
if [ -d "$APP/.git" ]; then
  say "Aktualisiere Code aus GitHub …"
  git -C "$APP" fetch --depth 1 origin "$BRANCH" >>"$LOG" 2>&1
  git -C "$APP" reset --hard "origin/$BRANCH" >>"$LOG" 2>&1
else
  say "Lade Code aus GitHub ($REPO) …"
  rm -rf "$APP"; git clone --depth 1 -b "$BRANCH" "$REPO" "$APP" >>"$LOG" 2>&1
fi
chown -R root:root "$APP"   # Jarvis darf seinen eigenen Programmcode NICHT verändern
chmod -R go-w "$APP"

say "Python-Umgebung …"
[ -x "$APP/.venv/bin/python" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip >>"$LOG" 2>&1
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt" >>"$LOG" 2>&1
"$APP/.venv/bin/pip" install -q -r "$APP/requirements-optional.txt" >>"$LOG" 2>&1 \
  || warn "Zusatzpakete (Sprache/Excel) nicht vollständig – Jarvis läuft trotzdem."

# ---------------------------------------------------------------- Ollama (lokale KI auf dem Server)
if ! command -v ollama >/dev/null 2>&1; then
  say "Installiere Ollama …"
  curl -fsSL https://ollama.com/install.sh | sh >>"$LOG" 2>&1
fi
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/jarvis.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_KEEP_ALIVE=-1"
EOF
systemctl daemon-reload
systemctl enable --now ollama >>"$LOG" 2>&1
systemctl restart ollama
for i in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done

RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
if [ -n "${JARVIS_MODEL:-}" ]; then MODEL="$JARVIS_MODEL"
elif [ "$RAM_GB" -ge 20 ]; then MODEL="qwen3:8b"
elif [ "$RAM_GB" -ge 5 ];  then MODEL="qwen3:4b-instruct-2507-q4_K_M"
else MODEL="qwen3:1.7b"; fi
if [ -f "$ENVF" ] && [ -z "${JARVIS_MODEL:-}" ]; then
  OLD=$(grep -E '^JARVIS_MODEL=' "$ENVF" | cut -d= -f2- || true); [ -n "$OLD" ] && MODEL="$OLD"
fi
say "RAM ${RAM_GB} GB → KI-Modell $MODEL (Download einmalig, mehrere GB) …"
ollama pull "$MODEL" >>"$LOG" 2>&1 || { echo "Modell-Download fehlgeschlagen, siehe $LOG"; exit 1; }

# ---------------------------------------------------------------- Zugang: privat (Tailscale) oder öffentlich (HTTPS)
ACCESS="public"
if [ -n "${TS_AUTHKEY:-}" ]; then
  ACCESS="tailscale"
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  ACCESS="tailscale"
fi
if [ "$ACCESS" = "tailscale" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    say "Installiere Tailscale (privates Netz nur für deine Geräte) …"
    curl -fsSL https://tailscale.com/install.sh | sh >>"$LOG" 2>&1
  fi
  if [ -n "${TS_AUTHKEY:-}" ]; then
    tailscale up --authkey "$TS_AUTHKEY" --hostname jarvis >>"$LOG" 2>&1 || tailscale up --authkey "$TS_AUTHKEY" >>"$LOG" 2>&1
  fi
  TSNAME=$(tailscale status --json | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
  if tailscale serve --bg --https=443 http://127.0.0.1:8765 >>"$LOG" 2>&1; then
    DOMAIN="$TSNAME"; SCHEME="https"
  else
    warn "Tailscale-HTTPS nicht aktiv (Tailscale-Admin → DNS → „HTTPS Certificates“ einschalten). Nutze HTTP im verschlüsselten Tailscale-Tunnel."
    tailscale serve --bg --http=80 http://127.0.0.1:8765 >>"$LOG" 2>&1 || true
    DOMAIN="$TSNAME"; SCHEME="http"
  fi
  systemctl disable --now caddy >>"$LOG" 2>&1 || true   # nichts öffentlich erreichbar
  say "Zugang nur über Tailscale: $SCHEME://$DOMAIN"
else
SCHEME="https"
PUBIP=$(curl -fs4 --max-time 10 https://api.ipify.org || curl -fs4 --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')
DOMAIN="${JARVIS_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$ENVF" ]; then
  DOMAIN=$(grep -E '^PUBLIC_BASE_URL=' "$ENVF" | cut -d= -f2- | sed -e 's#https\?://##' -e 's#/.*##' || true)
fi
[ -z "$DOMAIN" ] && DOMAIN="$(echo "$PUBIP" | tr . -).sslip.io"
say "Adresse: https://$DOMAIN"

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
    reverse_proxy 127.0.0.1:8765
}
EOF
systemctl enable caddy >>"$LOG" 2>&1; systemctl restart caddy

# Oracle-Ubuntu-Images blockieren per iptables alles außer SSH → 80/443 freigeben (dauerhaft)
for P in 80 443; do
  iptables -C INPUT -p tcp --dport $P -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport $P -m conntrack --ctstate NEW -j ACCEPT
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save >>"$LOG" 2>&1 || true
fi

# ---------------------------------------------------------------- Einstellungen (.env)
setv() {  # setv KEY VALUE  – setzt/ersetzt eine Zeile in der .env
  local k="$1" v="$2"
  touch "$ENVF"
  if grep -qE "^$k=" "$ENVF"; then
    python3 - "$ENVF" "$k" "$v" <<'PY'
import sys; f, k, v = sys.argv[1:]
lines = open(f, encoding="utf-8").read().splitlines()
open(f, "w", encoding="utf-8").write("\n".join(f"{k}={v}" if l.startswith(k + "=") else l for l in lines) + "\n")
PY
  else echo "$k=$v" >> "$ENVF"; fi
}
[ -f "$ENVF" ] || cp "$APP/.env.example" "$ENVF"
setv JARVIS_MODEL "$MODEL"
setv OLLAMA_BASE_URL "http://127.0.0.1:11434"
setv PUBLIC_BASE_URL "$SCHEME://$DOMAIN"
if [ -n "${JARVIS_PRIVACY:-}" ]; then
  setv JARVIS_PRIVACY "$JARVIS_PRIVACY"
elif ! grep -qE '^JARVIS_PRIVACY=' "$ENVF"; then
  setv JARVIS_PRIVACY "strikt"      # Einbahnstraße: Wissen herein, Privates bleibt hier
fi
setv JARVIS_KEEP_ALIVE "-1"          # Modell bleibt geladen: schnelle Antworten + Oracle hält den Server für aktiv
setv JARVIS_NUM_CTX "16384"
setv JARVIS_MAX_TOKENS "2048"
setv HISTORY_TURNS "10"
setv JARVIS_TOOL_RESULT_MAX "8000"
setv WHISPER_MODEL "base"
setv JARVIS_VISION_MODEL ""
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && setv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
[ -n "${TELEGRAM_OWNER_ID:-}" ] && setv TELEGRAM_ALLOWED_USER_IDS "$TELEGRAM_OWNER_ID"
[ -n "${XKIRO_API_KEY:-}" ] && setv XKIRO_API_KEY "$XKIRO_API_KEY"
[ -n "${ANTHROPIC_API_KEY:-}" ] && setv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
[ -n "${JARVIS_PROVIDER:-}" ] && setv JARVIS_PROVIDER "$JARVIS_PROVIDER"
setv JARVIS_FALLBACK_LOCAL "1"       # fällt die Cloud-KI aus, antwortet die lokale KI auf dem Server
[ -n "${OWNER_NAME:-}" ] && setv OWNER_NAME "$OWNER_NAME"
if [ -n "${JARVIS_PASSWORD:-}" ]; then
  setv JARVIS_PASSWORD "$JARVIS_PASSWORD"
elif ! grep -qE '^JARVIS_PASSWORD=.+' "$ENVF"; then
  PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  setv JARVIS_PASSWORD "$PW"
  warn "Kein Passwort angegeben – zufälliges Passwort erzeugt (steht in /root/jarvis-zugang.txt)."
fi
chown jarvis:jarvis "$ENVF"; chmod 600 "$ENVF"
PWNOW=$(grep -E '^JARVIS_PASSWORD=' "$ENVF" | cut -d= -f2-)
printf 'Jarvis online: %s://%s\nPasswort: %s\n' "$SCHEME" "$DOMAIN" "$PWNOW" > /root/jarvis-zugang.txt
chmod 600 /root/jarvis-zugang.txt

# ---------------------------------------------------------------- Dienst
cat > /etc/systemd/system/jarvis.service <<EOF
[Unit]
Description=J.A.R.V.I.S. online
After=network-online.target ollama.service
Wants=network-online.target ollama.service

[Service]
User=jarvis
Group=jarvis
WorkingDirectory=$APP
Environment=JARVIS_SERVER=1
Environment=DATA_DIR=$DATA
Environment=JARVIS_ENV_FILE=$ENVF
Environment=PYTHONUNBUFFERED=1
Environment=PORT=8765
ExecStart=$APP/.venv/bin/python -m jarvis.main
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable jarvis >>"$LOG" 2>&1
systemctl restart jarvis

say "Warte auf Jarvis …"
for i in $(seq 1 40); do curl -fs http://127.0.0.1:8765/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8765/health >/dev/null || { echo "Jarvis startet nicht: journalctl -u jarvis -n 80"; exit 1; }

# ---------------------------------------------------------------- Tägliches verschlüsseltes Backup
cat > /etc/systemd/system/jarvis-backup.service <<UNIT
[Unit]
Description=Jarvis verschlüsseltes Backup
[Service]
Type=oneshot
ExecStart=$APP/deploy/oracle/backup.sh
UNIT
cat > /etc/systemd/system/jarvis-backup.timer <<'UNIT'
[Unit]
Description=Jarvis Backup täglich
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now jarvis-backup.timer >>"$LOG" 2>&1 || true
"$APP/deploy/oracle/backup.sh" >>"$LOG" 2>&1 || warn "Erstes Backup fehlgeschlagen (siehe $LOG)."
{
  echo "Datenschlüssel (verschlüsselt private Inhalte): $DATA/jarvis.key  -> Inhalt sicher aufbewahren!"
  echo "Backup-Passwort: /root/jarvis-backup.pass -> Inhalt sicher aufbewahren!"
} >> /root/jarvis-zugang.txt

# Modell vorwärmen (erste Antwort sonst langsam)
curl -fs http://127.0.0.1:11434/api/generate -d "{\"model\":\"$MODEL\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" >/dev/null || true

echo
echo -e "${C}==================== FERTIG ====================${N}"
echo " Jarvis online:  $SCHEME://$DOMAIN"
if [ "$ACCESS" = "tailscale" ]; then echo "                 (nur von deinen Geräten im Tailscale-Netz erreichbar)"; fi
echo " Passwort:       steht in /root/jarvis-zugang.txt   (sudo cat /root/jarvis-zugang.txt)"
echo " Telegram:       im Jarvis-Fenster einloggen → rechts „/koppeln <Code>“ an deinen Bot schicken"
echo " Logs:           sudo journalctl -u jarvis -f"
echo " Update:         sudo /opt/jarvis/deploy/oracle/update.sh"
echo -e "${C}================================================${N}"
