# pi-repl — TypeScript host driving a real ipykernel over the Jupyter protocol.
# Host tooling (bun test, bunx biome) is driven by Bun; there is no Python guest anymore.

BIOME := "bunx biome"
KNIP := "bunx knip"

# ── format ────────────────────────────────────────────────────────────────
fmt:
	{{BIOME}} format --write .

# ── lint (biome) + dead-code (knip) ────────────────────────────────────────
lint:
	{{BIOME}} check .
	{{KNIP}}

# ── typecheck: the entry file is the one file the runtime actually executes — the gate checks it
# (unlike biome, tsc resolves imports, so a missing one can never ship again)
types:
	bunx tsc --noEmit

# ── security ──────────────────────────────────────────────────────────────
security:
	-npm audit --audit-level=high
	.venv/bin/python --version

# ── check (the gate: fmt + lint[+knip] + test) ─────────────────────────────
check: fmt lint types test

# ── test (the real spec) ──────────────────────────────────────────────────
test:
	bun test test/units.test.ts test/preview-core.test.ts

# ── integration (slow: boots a real kernel per engine; replaces the old guest contract) ──
integration:
	bun test test/engine.integration.test.ts

# ── ci (full gate) ────────────────────────────────────────────────────────
ci: check

# ── clean ─────────────────────────────────────────────────────────────────
clean:
	rm -rf node_modules .venv .pytest_cache .ruff_cache dist __pycache__
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

# ── setup (from clone to dev-ready) ────────────────────────────────────
# Creates a project-local venv (system python3 ≥3.11) if missing, then installs
# ipykernel (the host speaks the kernel protocol directly; jupyter_client is not
# needed by this repo anymore). CI calls this before running the gate.
setup:
	npm install
	# Prefer an existing repo venv; otherwise build one from a system python.
	if [ ! -x .venv/bin/python ]; then \
	  python3 -m venv .venv && \
	  .venv/bin/python -m pip install --upgrade pip; \
	fi
	.venv/bin/python -m pip install ipykernel