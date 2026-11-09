# VoiceLab – common tasks.   `make help` lists them.
SHELL := /bin/bash
PY    := backend/.venv/bin/python
UV    := UV_HTTP_TIMEOUT=300 uv

.DEFAULT_GOAL := help
.PHONY: help setup models start dev backend frontend build test agent agent-console agent-models livekit-server demo-agent clean

help:                ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup:               ## install Python + Node deps and download the local models
	cd backend && $(UV) sync --python 3.12 --extra livekit --extra dev
	cd frontend && npm install
	$(MAKE) models
	@test -f .env || cp .env.example .env
	@echo "\n✓ setup complete – run: make start"

models:              ## download Whisper + Piper voices (no API keys needed)
	$(PY) scripts/download_models.py

build:               ## build the dashboard into frontend/dist
	cd frontend && npm run build

start: build         ## build the dashboard and serve everything on http://localhost:8000
	cd backend && ../$(PY) -m uvicorn voicelab.main:app --host 127.0.0.1 --port 8000

dev:                 ## backend (:8000, auto-reload) + Vite dev server (:5173) – open http://localhost:5173
	@trap 'kill 0' EXIT; \
	(cd backend && ../$(PY) -m uvicorn voicelab.main:app --host 127.0.0.1 --port 8000 --reload) & \
	(cd frontend && npm run dev -- --host 127.0.0.1) & \
	wait

backend:             ## backend only
	cd backend && ../$(PY) -m uvicorn voicelab.main:app --host 127.0.0.1 --port 8000 --reload

frontend:            ## Vite dev server only
	cd frontend && npm run dev

test:                ## run the backend test-suite + type-check the dashboard
	cd backend && ../$(PY) -m pytest -q
	cd frontend && npx tsc -b

# ---- LiveKit ---------------------------------------------------------------------------------
livekit-server:      ## local LiveKit dev server (brew install livekit) – key "devkey", secret "secret"
	livekit-server --dev

agent-models:        ## download the LiveKit turn-detector weights (once)
	$(PY) livekit_agent/agent.py download-files

agent:               ## run the course-faithful LiveKit agent worker (needs provider keys in .env)
	$(PY) livekit_agent/agent.py dev

agent-console:       ## talk to the LiveKit agent in your terminal – no LiveKit server needed
	$(PY) livekit_agent/agent.py console

demo-agent:          ## keyless demo: publishes fake metrics into room "voicelab-demo" for the LiveKit page
	$(PY) livekit_agent/demo_publisher.py --room voicelab-demo

clean:               ## remove build output and caches (keeps models and .env)
	rm -rf frontend/dist backend/.pytest_cache
