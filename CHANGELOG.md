# Changelog

All notable changes to pi-repl, grouped by day and by type.

## 2026-08-09 — Description is the truth

### Changed / docs
- Reframed the `execute` tool's description + snippet as a **persistent notebook-style REPL** and
dropped the static function enumeration (it can't know config-loaded helpers like
`web_search`); the description now points at `ls()`/`help()` and the dynamic toolbox bullets
- Advertised the real kernel's notebook conveniences in the prompt: `!cmd` runs shell,
`%%bash`/`%timeit` magics work, with the division of labour — use `bash(cmd)` when output
must come back as a Python variable (it returns the CompletedProcess)
- Toolbox loader stops deriving signatures from `def` lines (the regex grabbed
a private helper like `_get_env(key)` as the advertised call for `bash`/
`web_search`); the model-facing surface is now `function_description` only,
rendered verbatim with no parsing
- `function_description` convention: first line is the call shape, then what
it does, then an `Instead of:` line naming the stdlib call it replaces, so a
model about to hand-roll the same thing sees a better version already exists
- Updated the shipped `read`/`write`/`edit`/`bash` descriptions to the new
convention (call shape + `Instead of:` equivalence)
- `help(name)` now leads with the REAL signature from the live function via
`inspect.signature`, making the kernel channel mechanically truthful even if
a description drifts
- Rewrote the toolbox file contract in `docs/how-to-functions.md`;
`how-to-functions.md` documents the first-line call-shape convention

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

## 2026-08-09 — Structure & docs

### Structure / refactor
- Split the preview logic out of `preview-core.ts` into a single-concern `preview/` module (`types` / `descriptor` / `scan` / `shell` / `candidates` / `index`), leaving a thin aggregator so importers stay untouched
- Split the execute prompt into a pure contract (`prompt.ts`) plus a thin adapter (`tool-meta.ts`), mirroring the schema/domain split; `index.ts` imports are unchanged
- Prompt rewrite on the new split: sectioned guidance (What's in every cell / How to use them / Examples / Efficiency / When it breaks), the "these are your file and shell tools" thesis stated once, `ls()` as the explicit first move, and each rule led by a concrete condition; no guidance dropped, a few supporting details compressed
- Dropped the trailing `─` border row under an expanded tool call (the coloured status border remains)

### Docs
- Documented the unified `~/.pi/agent/pi-repl/` layout (config.json / venv / state/) and the merge/override toolbox semantics
- Moved `ARCHITECTURE.md` into `docs/` beside the other narrative docs; repointed README/CHANGELOG links and the packaged `files` list

---

See docs/ARCHITECTURE.md for the design and `docs/` for how-to material.