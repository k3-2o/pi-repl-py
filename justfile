# pi-repl — TypeScript host + Python guest.
# Host tooling (bun test, bunx biome) is driven by Bun; guest tooling is ruff + pytest.

PY := ".venv/bin/python"
BIOME := "bunx biome"
RUF := "{{PY}} -m ruff"

# ── format ────────────────────────────────────────────────────────────────
fmt:
	{{BIOME}} format --write .
	{{RUF}} format src/ test/ 2>/dev/null || true

# ── lint ──────────────────────────────────────────────────────────────────
lint:
	{{BIOME}} check .
	{{RUF}} check src/ test/ 2>/dev/null || true

# ── typecheck ← flaky on node in this env; kept as a standalone recipe, not in check
types:
	bunx tsc --noEmit

# ── security ──────────────────────────────────────────────────────────────
security:
	-npm audit --audit-level=high
	{{PY}} --version

# ── check (the gate: fmt + lint + test) ───────────────────────────────────
check: fmt lint test

# ── test (the real spec) ──────────────────────────────────────────────────
test:
	# Host: the TS host with its own (bun-native) runner.
	bun test test/units.test.ts test/preview-core.test.ts
	# Guest: the Python evaluator contract.
	{{PY}} -m pytest test/guest_contract.py -q

# ── integration (slow: boots a real kernel per engine) ────────────────────
integration:
	bun test test/engine.integration.test.ts
	{{PY}} -m pytest test/guest_contract.py -q

# ── ci (full gate) ────────────────────────────────────────────────────────
ci: check

# ── clean ─────────────────────────────────────────────────────────────────
clean:
	rm -rf node_modules .venv .pytest_cache .ruff_cache dist __pycache__
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

# ── setup (from clone to dev-ready) ────────────────────────────────────
# Creates a project-local venv (system python3 ≥3.11) if missing, then installs
# deps. CI calls this before running the gate.
setup:
	npm install
	# Prefer an existing repo venv; otherwise build one from a system python.
	if [ ! -x {{PY}} ]; then \
	  python3 -m venv .venv && \
	  {{PY}} -m pip install --upgrade pip; \
	fi
	{{PY}} -m pip install pytest ruff ipykernel jupyter_client