# Changelog

All notable changes to pi-repl, grouped by day and by type.

## 2026-08-08 — Port & foundation

### Added
- Initial scoped port of shift-labs/pi-rlm onto a Python-guest REPL
- Evaluator is a real `ipykernel` guest driven via `jupyter_client`
- Config surface + stable Python runtime + Python-idiom prompt
- Configurable toolbox functions (`read`/`write`/`edit`/`bash`) loaded per kernel
- Auto-built evaluator venv on install; activation flag renamed to `--repl`
- Minimal system prompt with a dynamically loaded toolbox and a documented file contract

### Fixes
- Host now tolerates the guest's JSON frame format (`json.dumps` adds a space after `:`)

### Changed / docs
- Removed the dead tools-bridge + subagents stack; renamed `tools/` → `toolbox/`
- Rewrote README / AGENTS / ARCHITECTURE for the Python-repl version
- Trimmed comment clutter across host + guest; trimmed README to a front door

## 2026-08-08 — UI rendering

### Fixes
- Put the execute body in the result slot so Ctrl+O expands it; keep the Ctrl+O hint visible in narrow rows and add a keybinding fallback when pi's lookup is empty
- Highlight Python as Python (not TypeScript); sanitize output and highlight the block as a whole; color-code stdout/stderr/result/error

### Tests / features
- `bash()` extended with env, stdin, cwd, and timeout

## 2026-08-09 — Robustness & prompt rework

### Added
- knip added and its findings cleared; audit working file ignored

### Fixes (the wedge family)
- Report cell timeouts instead of silently succeeding; give snapshot/restore their own window
- Serialize a concurrent first engine build; tear down a boot-timeout child; cap the live stream feed
- Remove the per-cell wall-clock cap; use a silence watchdog; `bash()` kills its whole process group on timeout
- Recover the kernel when a cell is aborted; a failed snapshot no longer clobbers the last good one; cap guest-side output so a runaway print can't balloon memory
- Strip ANSI color from output/tracebacks; clean up `ls()`
- Remove the vestigial `Bun.$` accent path; always syntax-highlight cells as Python

### Prompt rework (default-prompt route)
- Drop the custom system prompt; carry the REPL doctrine on the `execute` tool; the function map derives from real signatures + `function_description`
- Agent guidance: reuse defined functions and build one parameterized tool; a reset drops user functions; stronger reuse/token guidance; prefer `find`/`du`/`fd`/`grep` over a Python `os.walk`; stay token-lean when printing

### Tests
- An aborted long cell does not wedge the next engine (backfill regression)

### Chore
- Normalize every comment to a one-line `// --- … ---` / `# --- … ---` and collapse verbose file-top docblocks

---

See `ARCHITECTURE.md` for the design and `docs/` for how-to material.