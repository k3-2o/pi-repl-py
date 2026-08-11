# Changelog

All notable changes to pi-repl, grouped by day and by type.

## 2026-08-12 — Workspace prompt rewrite; drop the ls()/help() discovery intrinsics

### Changed

- **Rewrote the `execute` tool contract into a workspace manual.** `executeToolDescription`
  is now a short capability statement (one persistent Python workspace, everything done
  in Python); `executePromptSnippet` is a one-line behavioral trigger; and
  `buildPromptGuidelines` carries the full doctrine: this workspace is the only tool,
  the generate → execute → observe → iterate loop, state reuse, chaining big tasks into
  verifiable steps, safe Python file edits (read full → modify → write → verify),
  batching independent work vs keeping exploratory cells small, output/discipline,
  the environment boundary, and the engine reset guard. Discovery, helper loading,
  and the runtime guarantees are unchanged; the wording is grounded in external
  practitioner guidance on code-executing agents and REPL harnesses.
- **Empty helpers dir no longer injects a placeholder line.** `tool-meta.ts` now passes
  an empty array, so the prompt simply omits the Helpers section instead of telling the
  model to "build your own."

### Removed

- **Deleted the custom `ls()` and `help()` discovery intrinsics.** The tool guidance
  already injects every helper's description verbatim, so bespoke discovery helpers were
  their own folder of duplicated mechanism, and a bespoke filter that races the
  project's "everything is plain Python" stance. The kernel no longer preloads
  `INTRINSIC`; the skip-list no longer names `ls`/`help`; the prompt now points the
  model at plain `[k for k in globals() if not k.startswith('_')]` and `name.__doc__`.
  The two contract tests were rewritten (not weakened) to pin the new guarantee — no
  injected intrinsics; helpers appear under `globals()`.

### Fixes

- **Kernel startup no longer races the connection file.** `KernelClient.start` polled
  with `!existsSync()`, which returns the instant the file is created, before ipykernel
  finishes writing it; reading that partial JSON threw `Unexpected EOF` and
  intermittently failed an integration test (a different one each run). The poll now
  retries `readConnectionFile` until it parses as valid JSON, keeping the child-exit
  and deadline guards. Integration suite confirms 5/5 full runs green.

## 2026-08-11 — Evict the shell() and edit() helpers; the REPL is plain Python

### Removed

- **Deleted the `shell()` and `edit()` helper blocks** (both the shipped defaults and
  the embeddings in `scripts/setup-venv.mjs`). A REPL already *is* a shell and a file
  editor, and the model kept defaulting to plain Python (`subprocess`, `!cmd`, `%%bash`,
  `open`, `pathlib`) anyway — the wrappers were redundant complexity for the model to
  ignore. `web_search()` stays (for now; to be redesigned separately).

### Changed

- **`scripts/setup-venv.mjs` no longer seeds any helpers.** It creates the user helpers
  dir empty on install; nothing is preloaded. Shell and file IO are native to the REPL.
- **The prompt now says shell and file IO are ordinary Python** — no special helper to
  learn. `!cmd`/`%%bash` for shell, `open()`/`pathlib.Path` for files.
- **The guest contract tests** dropped the shell/edit block suites and now assert the
  evicted helpers are *not* advertised by `ls()`, while any user helper still loads.

### Notes

- A fresh install has **zero** preloaded helpers until the user adds one (e.g.
  `web_search.py`).

## 2026-08-10 — Drop the config.json surface

### Removed

- **Deleted the configuration system entirely.** Removed `src/extension/config.ts`,
  `loadConfig()`, and the `~/.pi/agent/pi-repl/config.json` file. There is no config
  file and no knobs. Everything is fixed under `~/.pi/agent/pi-repl/`: the venv, the
  single helpers dir, and per-session state.
- **The helpers dir is fixed** at `~/.pi/agent/pi-repl/helpers` (matching the guest's
  `DEFAULT_HELPERS_DIR`) — the `helpersDir` config key is gone, so both host and guest
  are guaranteed to read the same dir. The engine no longer takes `pythonPath`/
  `timeoutMs`/`helpersDir` options; the interpreter is auto-resolved and the guest's
  defaults (no per-cell watchdog cap) apply.

### Added

- A short "The fixed layout" section in `docs/ARCHITECTURE.md` replacing the config
  reference, and matching README / how-to-functions updates.

## 2026-08-10 — Helpers, not files

### Changed

- **One helpers directory.** Removed the shipped `src/engine/toolbox` entirely. The single
  load location is now the user `helpers` dir (default `~/.pi/agent/pi-repl/helpers`); what
  lives there is everything the kernel loads. Config key `toolboxDir` → `helpersDir`; env
  `PI_TOOLBOX_DIR` → `PI_HELPERS_DIR`.
- **No helper folder in the package.** The default `shell.py` + `edit.py` helpers are
  emitted by `scripts/setup-venv.mjs` straight into `~/.pi/agent/pi-repl/helpers` on install
  (creating the dir and only the files that are missing — never clobbering a user edit).
  There is no `src/engine/helpers`, no templates dir; that user dir is the only place a
  helper `.py` ever lives.
- **`function_description` → `helper_description`.** The stale naming is gone everywhere
  (loader regex, guest, docs, README).
- **Pruned the toolkit.** Dropped shipped `read`/`write` (Python file IO is first-class;
  redundant). The shipped surface is two **context-manager building blocks**: `shell`
  (`with shell() as run:` then `run(cmd)`) owns only the fragile subprocess teardown (fresh
  process group, group-kill on timeout); `edit` (`with edit(path) as ed:` then mutate
  `ed.text`) owns only the fragile file WRITE — atomic commit, `.bak` backup, stale-file
  abort, and a printed diff. The model still writes the command / the exact text change,
  the parsing, and the decisions — non-lazy.
- **Prompt reframed to BROAD terms.** The tool description/snippet speak of "low-power
  helpers / building blocks" so more helper shapes can be added later without rewriting
  the contract; concrete mechanics live in the guidelines.
- **Earn-your-own-tools.** The guidelines teach the model to wrap a recurring helper shape
  into its own function/helper and reuse it (its defs are its library); long-running work
  drives a deliberate, generous timeout.
- Updated the docs (`how-to-functions.md`, `ARCHITECTURE.md`, `README.md`, `philosophy.md`)
  and tests for the helpers-only model.

## 2026-08-09 — Description is the truth

### Changed / docs
- Reframed the `execute` tool's description + snippet as a **persistent notebook-style REPL** and
dropped the static function enumeration (it can't know config-loaded helpers like
`web_search`); the description now points at `ls()`/`help()` and the dynamic toolbox bullets
- Advertised the real kernel's notebook conveniences in the prompt: `!cmd` runs shell,
`%%bash`/`%timeit` magics work, with the division of labour — use `bash(cmd)` when output
must come back as a Python variable (it returns the CompletedProcess)
- Instilled the persistent-workspace doctrine: defs are working memory, recurred shapes
become reusable functions, rewriting is the failure mode, `ls()` is the library; and the
efficiency doctrine: context is the budget, `;` suppresses a cell's echo, and
`web_search()` output is called out as the classic bloat trap (digest first, pull detail
only when a result looks relevant)
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