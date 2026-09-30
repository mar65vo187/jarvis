#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -r requirements.txt --disable-pip-version-check
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
exec .venv/bin/python -m jarvis --show
