#!/usr/bin/env python3
"""Install and run a local VoiceStudio next to VoiceLab – no GUI needed.

    python scripts/voicestudio.py install        clone the release + build its Python environment (PyTorch, ~2 GB)
    python scripts/voicestudio.py up             start the headless backend on :3900 and wait until it answers
    python scripts/voicestudio.py status         is it up? which engines, voices and models?
    python scripts/voicestudio.py models         list engines/models; `models install <repo_id> --yes` downloads one
    python scripts/voicestudio.py licences       which installed models still need their licence accepted (`licences accept <repo_id> --yes`)
    python scripts/voicestudio.py down | logs

VoiceStudio (https://github.com/debpalash/VoiceStudio, AGPL-3.0) is a separate program. This script only clones
its official release, runs its documented `setup:api` / `dev:api` steps, and talks to its HTTP API. VoiceLab never
imports or ships its code.  Standard library only, so it runs before anything else is installed.

Environment: VOICESTUDIO_HOME (checkout, default ../voicestudio), VOICESTUDIO_URL (default http://127.0.0.1:3900),
VOICESTUDIO_VERSION (git tag, default v0.5.7), VOICESTUDIO_API_KEY (remote servers only),
VOICESTUDIO_ASR_MODEL (Apple Silicon: the MLX Whisper checkpoint `up` selects, default whisper-large-v3-turbo).
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
HOME = Path(os.getenv("VOICESTUDIO_HOME") or ROOT.parent / "voicestudio").expanduser()
URL = (os.getenv("VOICESTUDIO_URL") or "http://127.0.0.1:3900").rstrip("/")
KEY = os.getenv("VOICESTUDIO_API_KEY") or os.getenv("OMNIVOICE_API_KEY") or ""
REPO = "https://github.com/debpalash/VoiceStudio.git"
TAG = os.getenv("VOICESTUDIO_VERSION", "v0.5.7")
STATE = ROOT / ".voicestudio"  # pid + log, git-ignored
PIDFILE, LOGFILE = STATE / "backend.pid", STATE / "backend.log"


# ----------------------------------------------------------------------------------------------
def say(msg: str = "") -> None:
    print(msg, flush=True)


def fail(msg: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]  # noqa: F821
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def http(path: str, *, method: str = "GET", body: dict | None = None, timeout: float = 5.0):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if KEY:
        req.add_header("Authorization", f"Bearer {KEY}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def healthy() -> dict | None:
    try:
        return http("/.well-known/voicestudio-speech", timeout=2.0)
    except Exception:
        return None


def port() -> int:
    return urlparse(URL).port or 3900


def need(tool: str, hint: str) -> str:
    p = shutil.which(tool)
    if not p:
        fail(f"`{tool}` not found. {hint}")
    return p


# ----------------------------------------------------------------------------------------------
def cmd_install(args) -> None:
    if platform.system() == "Darwin" and platform.machine() == "x86_64":
        fail("Intel Macs cannot run VoiceStudio's local backend (PyTorch ships no Intel-Mac wheels). Use an Apple Silicon Mac, "
             "or point VOICESTUDIO_URL at a VoiceStudio running elsewhere.")
    git, node, uv = need("git", "Install git."), need("node", "Install Node 20+ (https://nodejs.org)."), need("uv", "Install uv (https://docs.astral.sh/uv/).")
    free_gb = shutil.disk_usage(HOME.parent if HOME.parent.exists() else Path.home()).free / 1e9
    say(f"VoiceStudio {TAG} → {HOME}   ({free_gb:.0f} GB free; the Python environment is ~2 GB; each model adds 1–4 GB)")
    if free_gb < 12 and not args.force:
        fail("less than 12 GB free. Free some space, or re-run with --force.")
    if (HOME / "backend").is_dir():
        say("checkout already present – keeping it (delete the folder to reinstall).")
    else:
        if HOME.exists() and any(HOME.iterdir()):
            fail(f"{HOME} exists and is not a VoiceStudio checkout; choose another VOICESTUDIO_HOME.")
        say(f"cloning {REPO} @ {TAG} (shallow) …")
        subprocess.run([git, "clone", "--depth", "1", "--branch", TAG, REPO, str(HOME)], check=True)
    say("building the Python environment (uv sync --locked) – this downloads PyTorch and friends, be patient …")
    env = {**os.environ, "UV_HTTP_TIMEOUT": os.getenv("UV_HTTP_TIMEOUT", "300")}
    r = subprocess.run([node, "scripts/setup-api.mjs"], cwd=HOME, env=env)
    if r.returncode != 0:
        fail("setup failed (network hiccup? re-run `make studio-install`; completed downloads are cached).")
    say("\nInstalled. Next:  make studio-up      then check:  make studio-status")
    say("Models are NOT downloaded yet – see `make studio-models` (the first synthesis/transcription asks for them).")


def cmd_up(args) -> None:
    if healthy():
        say(f"VoiceStudio already answers at {URL} – nothing to do.")
        return cmd_status(args)
    if not (HOME / "backend").is_dir():
        fail(f"no VoiceStudio checkout at {HOME}. Run `make studio-install` first.")
    if not (HOME / ".venv").is_dir():
        fail("its Python environment is missing. Run `make studio-install`.")
    node = need("node", "Install Node 20+.")
    STATE.mkdir(exist_ok=True)
    env = {**os.environ, "OMNIVOICE_PORT": str(port())}
    if platform.system() == "Darwin" and platform.machine() == "arm64" and not env.get("ASR_MODEL"):
        # /v1/audio/transcriptions answers with the active engine's `ASR_MODEL`, which on Apple Silicon defaults to the
        # full 3 GB large-v3. The turbo checkpoint is about half the size and several times faster – the better fit for
        # a live agent – so start VoiceStudio pointing at it (override with VOICESTUDIO_ASR_MODEL).
        env["ASR_MODEL"] = os.getenv("VOICESTUDIO_ASR_MODEL", "mlx-community/whisper-large-v3-turbo")
    log = open(LOGFILE, "ab")
    # `dev-backend.mjs` is VoiceStudio's own headless launcher (what `bun run dev:api` runs): uvicorn on loopback with
    # crash restarts. Starting it ourselves is the supported "external backend" mode its desktop app can attach to.
    proc = subprocess.Popen([node, "scripts/dev-backend.mjs"], cwd=HOME, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    PIDFILE.write_text(str(proc.pid))
    say(f"starting VoiceStudio backend (pid {proc.pid}) on {URL} … logs: {LOGFILE.relative_to(ROOT)}")
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            fail(f"the backend exited early (code {proc.returncode}). See: make studio-logs")
        if healthy():
            say("up.")
            return cmd_status(args)
        time.sleep(1.0)
    fail(f"no answer from {URL} after {args.timeout}s (first start can be slow). Check: make studio-logs")


def cmd_down(args) -> None:
    if not PIDFILE.exists():
        say("no VoiceStudio started by this script." + (" (something else answers on the port – stop it where you started it.)" if healthy() else ""))
        return
    pid = int(PIDFILE.read_text())
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except ProcessLookupError:
        PIDFILE.unlink(missing_ok=True)
        say("already stopped.")
        return
    for _ in range(40):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.25)
    else:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    PIDFILE.unlink(missing_ok=True)
    say("stopped.")


def cmd_status(args) -> None:
    caps = healthy()
    if not caps:
        say(f"VoiceStudio: DOWN  ({URL})")
        say(f"  checkout : {'yes' if (HOME / 'backend').is_dir() else 'no'}  ({HOME})")
        say("  start it : make studio-up" if (HOME / "backend").is_dir() else "  install it: make studio-install")
        sys.exit(1)
    say(f"VoiceStudio: UP  {URL}  version {caps.get('service_version')}")
    try:
        models = http("/v1/models").get("data", [])
        asr = [m["id"] for m in models if m.get("voicestudio", {}).get("kind") == "stt" and not m["voicestudio"].get("alias_for_active_engine")]
        say(f"  ASR engine (active)  : {', '.join(asr) or '—'}")
        v = http("/v1/audio/voices")
        eng = [f"{e['id']}{'' if e.get('available') else ' (unavailable)'}" for e in v.get("engines", []) if isinstance(e, dict)]
        say(f"  TTS engines          : {', '.join(eng) or '—'}")
        profiles = [x for x in v.get("voices", []) if x.get("type") == "profile"]
        say(f"  voice profiles       : {len(profiles)}" + ("  (" + ", ".join(p['name'] for p in profiles[:6]) + ")" if profiles else ""))
    except Exception as e:
        say(f"  (could not read engines/voices: {e})")


def cmd_logs(args) -> None:
    if not LOGFILE.exists():
        fail("no log yet – start it with `make studio-up`.")
    os.execvp("tail", ["tail", "-n", str(args.lines), *(["-f"] if args.follow else []), str(LOGFILE)])


def _catalogue() -> list[dict]:
    """VoiceStudio's native model catalogue (GET /models): repo_id, role, size_gb, installed, license_info…"""
    return http("/models", timeout=60).get("models", [])


def _licence(m: dict) -> str:
    return (m.get("license_info") or {}).get("license") or "unspecified"


def cmd_models(args) -> None:
    if not healthy():
        fail("VoiceStudio is not running. `make studio-up` first.")
    cat = _catalogue()
    if args.action == "install":
        if not args.repo_id:
            fail("usage: models install <repo_id> --yes   (ids are listed by `make studio-models`)")
        m = next((x for x in cat if x.get("repo_id") == args.repo_id), None)
        if not m:
            fail(f"unknown model {args.repo_id!r}. Run `make studio-models` for the catalogue.")
        say(f"{m['repo_id']}  ·  {m.get('role')}  ·  ~{m.get('size_gb')} GB  ·  licence: {_licence(m)}")
        if m.get("installed"):
            say("already installed.")
            return
        if not args.yes:
            fail("model downloads are large and carry licences you should read. Re-run with --yes to proceed.")
        http("/models/install", method="POST", body={"repo_id": args.repo_id}, timeout=60)
        say("download started …")
        last = ""
        while True:
            jobs = [j for j in http("/models/install/status", timeout=30).get("jobs", []) if j.get("repo_id") == args.repo_id]
            if not jobs:
                break  # an empty list only means "finished" once the catalogue says installed (checked below)
            j = jobs[0]
            if str(j.get("state")).lower() == "failed":
                fail(f"install failed: {j}")
            done, total = j.get("bytes_done") or 0, j.get("total_bytes") or 0
            line = f"  {j.get('state')}: {done / 1e6:,.0f}/{total / 1e6:,.0f} MB" + (f"  {j['rate'] / 1e6:.1f} MB/s" if j.get("rate") else "") \
                + (f"  ETA {int(j['eta_seconds'] // 60)}m{int(j['eta_seconds'] % 60):02d}s" if j.get("eta_seconds") else "")
            if line != last:
                say(line)
                last = line
            time.sleep(5)
        now = next((x for x in _catalogue() if x.get("repo_id") == args.repo_id), {})
        if not now.get("installed"):
            fail("the download job ended but the model is not reported as installed – check `make studio-logs`.")
        say("installed ✓")
        return
    say(f"  {'':2}{'role':5} {'size':>8}  {'repo_id':46} licence")
    for m in sorted(cat, key=lambda m: (m.get("role", ""), m.get("size_gb") or 0)):
        if m.get("role") in ("TTS", "ASR") and m.get("curated") and m.get("supported", True):
            say(f"  {'●' if m.get('installed') else '○'} {m.get('role', ''):5} {str(m.get('size_gb', '?')) + ' GB':>8}  {m['repo_id'][:46]:46} {_licence(m)[:50]}")
    say("\n  ● installed   ○ available.  Install: python3 scripts/voicestudio.py models install <repo_id> --yes")


# Companion repos a model needs at run time (VoiceStudio names them in its "licence not accepted" error).
_COMPANIONS = {"k2-fsa/OmniVoice": ["eustlb/higgs-audio-v2-tokenizer"]}


def _terms(repo_id: str) -> dict:
    return http("/models/licenses/details/" + repo_id, timeout=30)


def cmd_licences(args) -> None:
    """VoiceStudio will not run a model until the person using it has accepted its licence. Listing is read-only;
    recording an acceptance is a deliberate act – it states that you hold the rights those terms require – so it needs
    --yes and happens only for the repo ids named on the command line."""
    if not healthy():
        fail("VoiceStudio is not running. `make studio-up` first.")
    if args.action == "accept":
        if not args.repo_ids:
            fail("usage: licences accept <repo_id> [<repo_id> …] --yes   (see `make studio-licences`)")
        for rid in args.repo_ids:
            d = _terms(rid)
            info, acc = d.get("info") or {}, d.get("acceptance") or {}
            say(f"{rid}\n  licence : {info.get('license', 'unspecified')}  ({acc.get('category') or info.get('license_category')})")
            for k in ("notes", "source_url"):
                if info.get(k):
                    say(f"  {k:8}: {info[k]}")
            if acc.get("accepted"):
                say("  already accepted.")
                continue
            if not args.yes:
                fail("read the terms above (source_url), then re-run with --yes to record that you accept them.")
            http("/models/licenses/accept", method="POST", body={"repo_id": rid, "fingerprint": acc["fingerprint"], "accepted": True}, timeout=30)
            say("  accepted ✓")
        return
    rows = []
    for m in _catalogue():
        if m.get("installed") and m.get("role") in ("TTS", "ASR"):
            for rid in [m["repo_id"], *_COMPANIONS.get(m["repo_id"], [])]:
                rows.append((m.get("role"), rid))
    if not rows:
        say("no TTS/ASR models installed yet – see `make studio-models`.")
    for role, rid in rows:
        try:
            acc = _terms(rid).get("acceptance") or {}
        except Exception as e:  # noqa: BLE001
            say(f"  ?  {role:4} {rid}  ({e})")
            continue
        flag = "✓ accepted" if acc.get("accepted") else ("✗ needs acceptance" if acc.get("required") else "– not required")
        say(f"  {flag:18} {role:4} {rid:42} {acc.get('license', '')[:60]}")
    say("\n  Read the terms, then: python3 scripts/voicestudio.py licences accept <repo_id> [<repo_id> …] --yes")


def main() -> None:
    ap = argparse.ArgumentParser(description="Install and run a local VoiceStudio for VoiceLab")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("install"); p.add_argument("--force", action="store_true"); p.set_defaults(fn=cmd_install)
    p = sub.add_parser("up"); p.add_argument("--timeout", type=int, default=300); p.set_defaults(fn=cmd_up)
    sub.add_parser("down").set_defaults(fn=cmd_down)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    p = sub.add_parser("logs"); p.add_argument("-n", "--lines", type=int, default=60); p.add_argument("-f", "--follow", action="store_true"); p.set_defaults(fn=cmd_logs)
    p = sub.add_parser("models"); p.add_argument("action", nargs="?", default="list", choices=["list", "install"]); p.add_argument("repo_id", nargs="?")
    p.add_argument("--yes", action="store_true"); p.set_defaults(fn=cmd_models)
    p = sub.add_parser("licences"); p.add_argument("action", nargs="?", default="list", choices=["list", "accept"]); p.add_argument("repo_ids", nargs="*")
    p.add_argument("--yes", action="store_true"); p.set_defaults(fn=cmd_licences)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
