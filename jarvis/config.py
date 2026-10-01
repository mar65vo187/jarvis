"""Zentrale Konfiguration – aus .env (App-Ordner) bzw. Umgebungsvariablen. Live neu ladbar."""
import os
import platform
import sys
import json
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

APP_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = Path(os.environ.get("JARVIS_ENV_FILE", str(APP_DIR / ".env")))
IS_WINDOWS = sys.platform.startswith("win")
# LOCAL = läuft auf dem eigenen PC (nicht im Docker-Server)
LOCAL = os.environ.get("JARVIS_LOCAL", "1") == "1"


def load_env_file():
    """Liest .env ein (überschreibt vorhandene Werte, damit das Setup live greift)."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if len(v) >= 2 and line.split("=", 1)[1].strip().startswith('"'):
            try:
                v = json.loads(line.split("=", 1)[1].strip())
            except (ValueError, TypeError):
                pass
        os.environ[k.strip()] = str(v)


def save_env(values: dict):
    """Schreibt/aktualisiert Werte in der .env und lädt neu."""
    values = {str(k): str(v) for k, v in values.items()}
    for k, v in values.items():
        if not k.replace("_", "").isalnum() or "\n" in v or "\r" in v:
            raise ValueError("Ungültiger Einstellungswert.")
    validate_values(values)
    def encode(v):
        return json.dumps(v, ensure_ascii=False) if any(c in v for c in "\"'\\") or v != v.strip() else v
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    done = set()
    for i, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if k in values:
            lines[i] = f"{k}={encode(values[k])}"
            done.add(k)
    for k, v in values.items():
        if k not in done:
            lines.append(f"{k}={encode(v)}")
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".jarvis-env-", dir=ENV_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, ENV_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    reload()


def validate_values(values: dict):
    if values.get("JARVIS_PROVIDER", "auto") not in ("auto", "xkiro", "huggingface", "claude", "ollama"):
        raise ValueError("KI-Anbieter muss auto, xkiro, huggingface, claude oder ollama sein.")
    if "JARVIS_CLOUD_ENABLED" in values and values["JARVIS_CLOUD_ENABLED"] not in ("0", "1"):
        raise ValueError("JARVIS_CLOUD_ENABLED muss 0 oder 1 sein.")
    if "XKIRO_REASONING_EFFORT" in values and values["XKIRO_REASONING_EFFORT"] not in ("", "none", "low", "medium", "high", "xhigh", "max"):
        raise ValueError("XKIRO_REASONING_EFFORT ist ungültig.")
    for key in ("JARVIS_AGENTS_ENABLED", "JARVIS_AGENT_PREFER_FREE", "JARVIS_AGENT_ALLOW_PREMIUM",
                "JARVIS_AGENT_USE_XKIRO", "JARVIS_AGENT_USE_HF", "JARVIS_AGENT_USE_OLLAMA",
                "JARVIS_UPGRADE_AUTO", "JARVIS_UPGRADE_FREE_ONLY"):
        if key in values and values[key] not in ("0", "1"):
            raise ValueError(f"{key} muss 0 oder 1 sein.")
    if "JARVIS_AGENT_MODE" in values and values["JARVIS_AGENT_MODE"] not in ("off", "auto", "always"):
        raise ValueError("JARVIS_AGENT_MODE muss off, auto oder always sein.")
    for key, lo, hi in (("JARVIS_AGENT_MAX_AGENTS", 1, 8), ("JARVIS_AGENT_MAX_PARALLEL", 1, 6),
                        ("JARVIS_AGENT_MAX_TOKENS", 256, 4096), ("JARVIS_AGENT_MODEL_FALLBACKS", 1, 5),
                        ("JARVIS_AGENT_MISSION_EVERY", 1, 20), ("JARVIS_UPGRADE_INTERVAL_HOURS", 1, 168),
                        ("JARVIS_UPGRADE_MAX_CHILDREN", 1, 50), ("JARVIS_UPGRADE_BENCH_TASKS", 1, 4)):
        if key in values:
            try:
                n = int(values[key])
            except ValueError:
                raise ValueError(f"{key} muss eine Ganzzahl sein.") from None
            if not lo <= n <= hi:
                raise ValueError(f"{key} muss zwischen {lo} und {hi} liegen.")
    if "OLLAMA_BASE_URL" in values:
        u = urlsplit(values["OLLAMA_BASE_URL"])
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1") or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
            raise ValueError("OLLAMA_BASE_URL muss auf den lokalen Ollama-Dienst zeigen.")
        try:
            if not u.port:
                raise ValueError()
        except ValueError:
            raise ValueError("OLLAMA_BASE_URL braucht einen gültigen Port.") from None
    for key in ("CLAUDE_DAILY_BUDGET_USD", "CLAUDE_PRICE_IN", "CLAUDE_PRICE_OUT"):
        if key in values:
            try:
                n = float(values[key])
                import math
                if not math.isfinite(n) or n < 0:
                    raise ValueError()
            except ValueError:
                raise ValueError(f"{key} muss eine nichtnegative Zahl sein.") from None


def active_provider() -> str:
    if PROVIDER == "auto":
        if CLOUD_ENABLED and XKIRO_API_KEY:
            return "xkiro"
        if CLOUD_ENABLED and HF_TOKEN:
            return "huggingface"
        if CLOUD_ENABLED and ANTHROPIC_API_KEY:
            return "claude"
        return "ollama"
    if PROVIDER in ("xkiro", "huggingface", "claude") and not CLOUD_ENABLED:
        return "ollama"
    return PROVIDER


def active_model() -> str:
    provider = active_provider()
    if provider == "xkiro":
        return XKIRO_MODEL
    if provider == "huggingface":
        return HF_MODEL
    if provider == "claude":
        return CLAUDE_MODEL
    return MODEL


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def reload():
    load_env_file()
    g = globals()
    g["PROVIDER"] = _env("JARVIS_PROVIDER", "auto")
    g["CLOUD_ENABLED"] = _env("JARVIS_CLOUD_ENABLED", "1") == "1"
    g["XKIRO_API_KEY"] = _env("XKIRO_API_KEY")
    g["XKIRO_BASE_URL"] = "https://api.xkiro.com/v1"
    g["XKIRO_MODEL"] = _env("XKIRO_MODEL") or "openai/gpt-5.6-sol"
    g["XKIRO_TIMEOUT_SEC"] = max(10, _int("XKIRO_TIMEOUT_SEC", 105))
    g["XKIRO_NUM_CTX"] = max(4096, _int("XKIRO_NUM_CTX", 200000))
    g["XKIRO_MAX_TOKENS"] = max(256, _int("XKIRO_MAX_TOKENS", 4096))
    g["XKIRO_REASONING_EFFORT"] = _env("XKIRO_REASONING_EFFORT")
    # --- Hugging Face Inference Providers (OpenAI-kompatibler Router) ---
    g["HF_TOKEN"] = _env("HF_TOKEN") or _env("HUGGINGFACE_TOKEN")
    g["HF_BASE_URL"] = "https://router.huggingface.co/v1"
    g["HF_MODEL"] = _env("HF_MODEL") or "openai/gpt-oss-120b"
    g["HF_POLICY"] = _env("HF_POLICY", "cheapest")
    g["HF_TIMEOUT_SEC"] = max(10, _int("HF_TIMEOUT_SEC", 120))
    g["HF_NUM_CTX"] = max(4096, _int("HF_NUM_CTX", 128000))
    g["HF_MAX_TOKENS"] = max(256, _int("HF_MAX_TOKENS", 4096))
    # --- Multi-Agentenrat: spezialisierte Modelle beraten den Master-Jarvis ---
    g["AGENTS_ENABLED"] = _env("JARVIS_AGENTS_ENABLED", "1") == "1"
    g["AGENT_MODE"] = _env("JARVIS_AGENT_MODE", "auto") or "auto"
    g["AGENT_MAX_AGENTS"] = max(1, min(8, _int("JARVIS_AGENT_MAX_AGENTS", 5)))
    g["AGENT_MAX_PARALLEL"] = max(1, min(6, _int("JARVIS_AGENT_MAX_PARALLEL", 4)))
    g["AGENT_MAX_TOKENS"] = max(256, min(4096, _int("JARVIS_AGENT_MAX_TOKENS", 1200)))
    g["AGENT_MODEL_FALLBACKS"] = max(1, min(5, _int("JARVIS_AGENT_MODEL_FALLBACKS", 2)))
    g["AGENT_MISSION_EVERY"] = max(1, min(20, _int("JARVIS_AGENT_MISSION_EVERY", 4)))
    g["AGENT_PREFER_FREE"] = _env("JARVIS_AGENT_PREFER_FREE", "1") == "1"
    g["AGENT_ALLOW_PREMIUM"] = _env("JARVIS_AGENT_ALLOW_PREMIUM", "0") == "1"
    g["AGENT_USE_XKIRO"] = _env("JARVIS_AGENT_USE_XKIRO", "1") == "1"
    g["AGENT_USE_HF"] = _env("JARVIS_AGENT_USE_HF", "1") == "1"
    g["AGENT_USE_OLLAMA"] = _env("JARVIS_AGENT_USE_OLLAMA", "1") == "1"
    # --- Agent Factory / Upgrade-System ---
    g["UPGRADE_AUTO"] = _env("JARVIS_UPGRADE_AUTO", "1") == "1"
    g["UPGRADE_FREE_ONLY"] = _env("JARVIS_UPGRADE_FREE_ONLY", "1") == "1"
    g["UPGRADE_INTERVAL_HOURS"] = max(1, min(168, _int("JARVIS_UPGRADE_INTERVAL_HOURS", 24)))
    g["UPGRADE_MAX_CHILDREN"] = max(1, min(50, _int("JARVIS_UPGRADE_MAX_CHILDREN", 12)))
    g["UPGRADE_BENCH_TASKS"] = max(1, min(4, _int("JARVIS_UPGRADE_BENCH_TASKS", 2)))
    g["ANTHROPIC_API_KEY"] = _env("ANTHROPIC_API_KEY") or _env("CLAUDE_API_KEY")
    g["CLAUDE_MODEL"] = _env("CLAUDE_MODEL") or "claude-sonnet-5-5"
    g["CLAUDE_TIMEOUT_SEC"] = max(10, _int("CLAUDE_TIMEOUT_SEC", 180))
    g["CLAUDE_NUM_CTX"] = max(4096, _int("CLAUDE_NUM_CTX", 100000))
    g["CLAUDE_MAX_TOKENS"] = max(256, _int("CLAUDE_MAX_TOKENS", 4096))
    validate_values({"JARVIS_PROVIDER": g["PROVIDER"],
                     "JARVIS_CLOUD_ENABLED": "1" if g["CLOUD_ENABLED"] else "0",
                     "XKIRO_REASONING_EFFORT": g["XKIRO_REASONING_EFFORT"],
                     "JARVIS_AGENTS_ENABLED": "1" if g["AGENTS_ENABLED"] else "0",
                     "JARVIS_AGENT_MODE": g["AGENT_MODE"],
                     "JARVIS_AGENT_MAX_AGENTS": str(g["AGENT_MAX_AGENTS"]),
                     "JARVIS_AGENT_MAX_PARALLEL": str(g["AGENT_MAX_PARALLEL"]),
                     "JARVIS_AGENT_MAX_TOKENS": str(g["AGENT_MAX_TOKENS"]),
                     "JARVIS_AGENT_MODEL_FALLBACKS": str(g["AGENT_MODEL_FALLBACKS"]),
                     "JARVIS_AGENT_MISSION_EVERY": str(g["AGENT_MISSION_EVERY"]),
                     "JARVIS_AGENT_PREFER_FREE": "1" if g["AGENT_PREFER_FREE"] else "0",
                     "JARVIS_AGENT_ALLOW_PREMIUM": "1" if g["AGENT_ALLOW_PREMIUM"] else "0",
                     "JARVIS_AGENT_USE_XKIRO": "1" if g["AGENT_USE_XKIRO"] else "0",
                     "JARVIS_AGENT_USE_HF": "1" if g["AGENT_USE_HF"] else "0",
                     "JARVIS_AGENT_USE_OLLAMA": "1" if g["AGENT_USE_OLLAMA"] else "0",
                     "JARVIS_UPGRADE_AUTO": "1" if g["UPGRADE_AUTO"] else "0",
                     "JARVIS_UPGRADE_FREE_ONLY": "1" if g["UPGRADE_FREE_ONLY"] else "0",
                     "JARVIS_UPGRADE_INTERVAL_HOURS": str(g["UPGRADE_INTERVAL_HOURS"]),
                     "JARVIS_UPGRADE_MAX_CHILDREN": str(g["UPGRADE_MAX_CHILDREN"]),
                     "JARVIS_UPGRADE_BENCH_TASKS": str(g["UPGRADE_BENCH_TASKS"])})
    # --- Lokales Gehirn (Ollama) ---
    g["OLLAMA_BASE_URL"] = _env("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    validate_values({"JARVIS_PROVIDER": g["PROVIDER"], "OLLAMA_BASE_URL": g["OLLAMA_BASE_URL"]})
    g["MODEL"] = _env("JARVIS_MODEL") or "qwen3:8b"
    # Optionales Seh-Modell für Screenshots/Fotos (z.B. qwen3-vl:4b). Leer = aus.
    g["VISION_MODEL"] = _env("JARVIS_VISION_MODEL", "")
    # qwen3 & Co.: Denkmodus kostet lokal viel Zeit – standardmäßig aus.
    g["THINK"] = _env("JARVIS_THINK", "0") == "1"
    g["MAX_TOKENS"] = _int("JARVIS_MAX_TOKENS", 4096)
    g["NUM_CTX"] = _int("JARVIS_NUM_CTX", 16384)
    g["TEMPERATURE"] = _float("JARVIS_TEMPERATURE", 0.2)
    g["OLLAMA_TIMEOUT_SEC"] = _int("OLLAMA_TIMEOUT_SEC", 900)
    # Wie lange das Modell nach der letzten Anfrage im RAM bleibt (wenig RAM → kurz, z.B. 5m).
    g["KEEP_ALIVE"] = _env("JARVIS_KEEP_ALIVE") or "30m"
    # Maximale Länge eines Werkzeug-Ergebnisses, das ans Modell geht (Zeichen).
    g["TOOL_RESULT_MAX"] = max(1000, _int("JARVIS_TOOL_RESULT_MAX", 12000))
    # --- Zugriff ---
    # 1 = Jarvis darf alle Dateien lesen/schreiben, die dein Windows-Benutzer darf.
    # Löschen, Verschieben, Systemeingriffe und neue Skills brauchen trotzdem deine Freigabe (im Code erzwungen).
    g["FULL_ACCESS"] = _env("JARVIS_FULL_ACCESS", "1") == "1"
    # --- Online-Teil (n8n auf eigenem Server). Jarvis ruft nur ausgehend auf, kein offener Port am PC. ---
    g["N8N_BASE_URL"] = _env("N8N_BASE_URL").rstrip("/")
    g["N8N_SECRET"] = _env("N8N_SECRET")
    # Lokale Inferenz kostet keine API-Gebühren; Feld bleibt für HUD-Kompatibilität.
    g["DAILY_BUDGET_USD"] = max(0, _float("CLAUDE_DAILY_BUDGET_USD", 1.0))
    g["PRICE_IN"] = max(0, _float("CLAUDE_PRICE_IN", 2.0)) / 1_000_000
    g["PRICE_OUT"] = max(0, _float("CLAUDE_PRICE_OUT", 10.0)) / 1_000_000
    g["PRICE_SEARCH"] = 0.0
    # --- Identität ---
    g["OWNER_NAME"] = _env("OWNER_NAME") or "Marvin"
    g["OWNER_TITLE"] = _env("OWNER_TITLE") or "Sir"
    g["OWNER_INFO"] = _env("OWNER_INFO") or ("Marvin Egenolf, Inhaber & CEO der TarifWerk (Vertriebs- und "
                           "Beratungsagentur, Wiesbaden). Bereiche: Internet/Mobilfunk, Energie, Solar, "
                           "Versicherungen, Immobilien, Edelmetalle. Baut ein Vertriebspartner-Netz auf. "
                           "Website tarifwerk.eu.")
    try:
        g["TIMEZONE"] = ZoneInfo(_env("TZ") or "Europe/Berlin")
    except Exception:
        g["TIMEZONE"] = ZoneInfo("Europe/Berlin")
    # --- Zugänge ---
    g["TELEGRAM_BOT_TOKEN"] = _env("TELEGRAM_BOT_TOKEN")
    ids = {int(x) for x in _env("TELEGRAM_ALLOWED_USER_IDS").replace(" ", "").split(",") if x.isdigit()}
    old = g.get("TELEGRAM_ALLOWED_USER_IDS")
    if isinstance(old, set):
        old.clear(); old.update(ids)
    else:
        g["TELEGRAM_ALLOWED_USER_IDS"] = ids
    g["JARVIS_PASSWORD"] = _env("JARVIS_PASSWORD")
    g["PORT"] = _int("PORT", 8765)
    g["HOST"] = "127.0.0.1"  # unverhandelbar: nie öffentlich binden
    g["PUBLIC_BASE_URL"] = f"http://127.0.0.1:{g['PORT']}"
    # --- Lokale Sprache ---
    g["WHISPER_MODEL"] = _env("WHISPER_MODEL", "small")
    g["WHISPER_DEVICE"] = _env("WHISPER_DEVICE", "auto")
    # --- optionale externe Integrationen (keine LLM-Inferenz) ---
    g["SMTP_HOST"] = _env("SMTP_HOST")
    g["SMTP_PORT"] = _int("SMTP_PORT", 465)
    g["SMTP_USER"] = _env("SMTP_USER")
    g["SMTP_PASS"] = _env("SMTP_PASS")
    g["SMTP_FROM"] = _env("SMTP_FROM") or g["SMTP_USER"]
    g["IMAP_HOST"] = _env("IMAP_HOST")
    g["IMAP_USER"] = _env("IMAP_USER") or g["SMTP_USER"]
    g["IMAP_PASS"] = _env("IMAP_PASS") or g["SMTP_PASS"]
    g["STRIPE_SECRET_KEY"] = _env("STRIPE_SECRET_KEY")
    # --- Autonomie ---
    g["MISSION_INTERVAL_MIN"] = _int("MISSION_INTERVAL_MIN", 30)
    g["MISSION_MAX_STEPS"] = _int("MISSION_MAX_STEPS", 20)
    g["CHAT_MAX_STEPS"] = _int("CHAT_MAX_STEPS", 24)
    g["HISTORY_TURNS"] = _int("HISTORY_TURNS", 16)
    g["SHELL_TIMEOUT"] = _int("SHELL_TIMEOUT", 120)
    g["APPROVAL_WAIT_SEC"] = _int("APPROVAL_WAIT_SEC", 300)
    g["HOTKEY"] = _env("JARVIS_HOTKEY", "ctrl+alt+j")


# --- Speicherorte (einmalig) ---
load_env_file()
DATA_DIR = Path(os.environ.get("DATA_DIR", str(APP_DIR / "data"))).resolve()
WORKSPACE = DATA_DIR / "workspace"
SITES_DIR = DATA_DIR / "sites"
SKILLS_DIR = DATA_DIR / "skills"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "jarvis.db"
for _p in (DATA_DIR, WORKSPACE, SITES_DIR, SKILLS_DIR, BACKUP_DIR):
    _p.mkdir(parents=True, exist_ok=True)

TELEGRAM_ALLOWED_USER_IDS: set = set()
# Laufzeitstatus der lokalen KI (wird von main.check_ollama aktualisiert, vom HUD angezeigt)
OLLAMA_STATUS: dict = {"ok": False, "model_ok": False, "vision_ok": False, "msg": "prüfe …", "checked": 0.0}
CLAUDE_STATUS: dict = {"ok": False, "model_ok": False, "msg": "prüfe …", "checked": 0.0}
XKIRO_STATUS: dict = {"ok": False, "model_ok": False, "msg": "prüfe …", "checked": 0.0, "usage": ""}
HF_STATUS: dict = {"ok": False, "model_ok": False, "msg": "prüfe …", "checked": 0.0}
reload()

HOME = Path.home()
SYSTEM_INFO = f"{platform.system()} {platform.release()} ({platform.machine()}), Benutzer {os.environ.get('USERNAME') or os.environ.get('USER', '?')}, Home {HOME}"


def is_admin() -> bool:
    try:
        if IS_WINDOWS:
            import ctypes
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        return os.geteuid() == 0
    except Exception:
        return False


def secrets() -> dict:
    """Zusätzliche API-Keys: jede Variable SECRET_<NAME> ist für Jarvis per get_secret nutzbar."""
    return {k[7:]: v for k, v in os.environ.items() if k.startswith("SECRET_") and v}
