#!/usr/bin/env bash
# Einmal auf einem frischen Ubuntu-Server als root ausführen:  bash setup.sh n8n.deine-domain.de
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then read -r -p "Domain für n8n (z.B. n8n.tarifwerk.eu): " DOMAIN; fi
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Installiere Docker …"; curl -fsSL https://get.docker.com | sh
fi
if [ ! -f .env ]; then
  printf 'N8N_DOMAIN=%s\nN8N_ENCRYPTION_KEY=%s\n' "$DOMAIN" "$(openssl rand -hex 32)" > .env
  chmod 600 .env
fi
# Firewall: nur SSH + Web
if command -v ufw >/dev/null 2>&1; then ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable; fi
docker compose up -d
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "FERTIG."
echo " 1) Bei STRATO (DNS) A-Record setzen:  $DOMAIN  ->  $IP"
echo " 2) Nach 1-5 Minuten: https://$DOMAIN öffnen und Owner-Konto anlegen."
echo " 3) Im Jarvis-Fenster → EINSTELLUNGEN → Erweitert: n8n-Adresse https://$DOMAIN eintragen."
echo " WICHTIG: Die .env hier (Verschlüsselungsschlüssel) sichern – ohne sie sind gespeicherte Zugangsdaten weg."
