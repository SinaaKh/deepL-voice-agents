#!/usr/bin/env python
"""Fetch the local models used by the default "Local stack" (no API keys needed).

    python scripts/download_models.py                 # Whisper base.en + two Piper voices
    python scripts/download_models.py --whisper tiny.en,base.en,small.en
    python scripts/download_models.py --livekit       # also the LiveKit semantic turn-detector weights

Run it with the backend virtualenv's python (`make models` does that for you).
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPER_DIR = ROOT / "backend" / "models" / "piper"
PIPER_VOICES = ["en_US-lessac-medium", "en_US-ryan-medium"]


def whisper(names: list[str]) -> None:
    from faster_whisper import WhisperModel

    for n in names:
        print(f"· Whisper {n}: downloading (cached in ~/.cache/huggingface) …", flush=True)
        WhisperModel(n, device="cpu", compute_type="int8")
        print(f"  ✓ {n}")


def piper() -> None:
    PIPER_DIR.mkdir(parents=True, exist_ok=True)
    missing = [v for v in PIPER_VOICES if not (PIPER_DIR / f"{v}.onnx").exists()]
    if not missing:
        print("· Piper voices already present ✓")
        return
    print(f"· Piper voices {missing}: downloading from the official rhasspy/piper-voices repo …", flush=True)
    subprocess.check_call([sys.executable, "-m", "piper.download_voices", "--download-dir", str(PIPER_DIR), *missing])
    print("  ✓ done")


def ollama() -> None:
    if not shutil.which("ollama"):
        print("· Ollama not found – install from https://ollama.com to use the local LLM (the 'Simulated' preset works without it).")
        return
    try:
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2) as r:
            body = r.read().decode()
    except Exception:
        print("· Ollama is installed but not running – start it (`ollama serve`) and run: ollama pull llama3.2")
        return
    if "llama3.2" in body or "qwen" in body or "llama3" in body:
        print("· Ollama chat model present ✓")
    else:
        print("· No chat model in Ollama yet – run: ollama pull llama3.2")


def livekit_models() -> None:
    agent = ROOT / "livekit_agent" / "agent.py"
    print("· LiveKit turn-detector / VAD weights …", flush=True)
    subprocess.call([sys.executable, str(agent), "download-files"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--whisper", default="base.en", help="comma separated faster-whisper model names")
    ap.add_argument("--livekit", action="store_true", help="also download LiveKit turn-detector weights")
    a = ap.parse_args()
    piper()
    whisper([n.strip() for n in a.whisper.split(",") if n.strip()])
    ollama()
    if a.livekit:
        livekit_models()
    print("\nAll set. Start the lab with:  make start")
