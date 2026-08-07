# pi-repl — TypeScript host + Python 3.14 guest.

PY := ".venv/bin/python"
BIOME := "npx biome"
RUF := "{{PY}} -m ruff"

# ── format ────────────────────────────────────────────────────────────────
fmt:
	{{BIOME}} format --write .
	{{RUF}} format src/ test/ 2>/dev/null || true

# ── lint ──────────────────────────────────────────────────────────────────
lint:
	{{BIOME}} check .
	{{RUF}} check src/ test/ 2>/dev/null || true
	npx tsc --noEmit

# ── typecheck ─────────────────────────────────────────────────────────────
types:
	npx tsc --noEmit

# ── security ──────────────────────────────────────────────────────────────
security:
	-npm audit --audit-level=high
	{{PY}} --version

# ── audit ─────────────────────────────────────────────────────────────────
audit:
	npm audit

# ── check (format + lint + types, the gate) ───────────────────────────────
check: fmt lint types security

# ── test ──────────────────────────────────────────────────────────────────
test:
	npx vitest run test/
	{{PY}} -m pytest test/ -q || true

# ── ci (full gate) ────────────────────────────────────────────────────────
ci: check test

# ── clean ─────────────────────────────────────────────────────────────────
clean:
	rm -rf node_modules .venv .pytest_cache .ruff_cache dist __pycache__
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

# ── setup (from clone to dev-ready) ───────────────────────────────────────
setup:
	npm install
	{{PY}} -m pip install pytest ruff