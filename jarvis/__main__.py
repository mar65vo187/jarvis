"""Portable entry point: python -m jarvis [--show | --check]."""
import argparse
import asyncio
import json
import sys


def run():
    parser = argparse.ArgumentParser(description="Jarvis: Claude oder lokale KI, Dashboard, Telegram und Missionen")
    parser.add_argument("--show", action="store_true", help="Dashboard im Browser öffnen")
    parser.add_argument("--check", action="store_true", help="Zugang/Modell prüfen, ohne KI-Text zu erzeugen")
    parser.add_argument("--version", action="version", version="Jarvis 2.0.0")
    args = parser.parse_args()
    from . import config, main
    if args.check:
        status = asyncio.run(main.check_provider())
        print(json.dumps({"provider": config.active_provider(), "model": config.active_model(), **status}, ensure_ascii=False))
        return 0 if status.get("ok") and status.get("model_ok") else 1
    if args.show:
        from . import desktop
        import threading
        import time

        def open_when_ready():
            for _ in range(40):
                if desktop.running():
                    desktop.open_window()
                    return
                time.sleep(0.25)

        threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        asyncio.run(main.main())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(run())
