"""Lokale Sprache-zu-Text-Transkription mit faster-whisper."""
import asyncio
import os
import tempfile
from pathlib import Path

from . import config

_model = None


def enabled() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        device = config.WHISPER_DEVICE
        if device == "auto":
            device = "cuda" if os.environ.get("CUDA_PATH") else "cpu"
        compute = "float16" if device == "cuda" else "int8"
        try:
            _model = WhisperModel(config.WHISPER_MODEL, device=device, compute_type=compute)
        except Exception:
            if device == "cpu":
                raise
            _model = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


async def transcribe(data: bytes, filename: str = "audio.ogg") -> str:
    if not enabled():
        raise RuntimeError("Lokale Spracheingabe fehlt: Paket 'faster-whisper' ist nicht installiert.")
    suffix = Path(filename).suffix or ".ogg"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        Path(path).write_bytes(data)
        def run():
            segments, _info = _get_model().transcribe(path, language="de", vad_filter=True)
            return " ".join(s.text.strip() for s in segments if s.text.strip()).strip()
        return await asyncio.to_thread(run)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


async def speak(text: str, fmt: str = "mp3") -> bytes | None:
    # TTS bleibt bewusst aus, bis ein verlässlich lokales Format für Browser + Telegram konfiguriert ist.
    return None
