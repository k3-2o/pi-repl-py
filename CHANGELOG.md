# Changelog

## [0.2.4] - 2026-08-13

### Added

- Documented the **Termux / Android** install path: `ipykernel`'s `psutil>=5.7` dependency has no PyPI Android wheel, so the venv build fails with `platform android is not supported`. Notes the two non-fixes (`python-psutil`, `psutil-android` ABI mismatch) and the working patched-source build of `psutil`, then installs it into the venv before `ipykernel`.

## [0.2.3] - 2026-08-12

### Changed

- Rewrote the `execute` tool prompt contract: the Python workspace is framed as the model's working memory and action language rather than a stateless tool rack. Trimmed redundant guidance, kept the two load-bearing rules (set `timeout` on hanging shell; re-verify after an `<repl_engine_reset>`) and carried verbatim, source-trimmed clauses from CodeAct and RLM prompts.

## [0.2.2] - 2026-08-12

### Fixed

- The venv postinstall no longer silently leaves a broken evaluator. It now verifies `ipykernel` is importable (not just that the venv binary exists), repairs a half-built venv, and exits non-zero on a failed build so `npm install` / `pi install` fails loudly instead of installing a dead evaluator. Existing helpers and per-session state are never touched.

## [0.2.1] - 2026-08-12

### Changed

- Corrected the helper definition to a preloaded `.py` file (not strictly a function): it can define functions, classes, constants, imports, or manage a tricky piece of complexity. Applied to `README.md` and `docs/helpers.md`.
- Renamed `docs/how-to-functions.md` → `docs/helpers.md`; repointed README and ARCHITECTURE links.

## [0.2.0] - 2026-08-12

### Added

- Timeout guidance in the `execute` prompt: set `timeout=` on `subprocess.run` for shell that can hang, since the evaluator does not kill silent cells automatically.

### Changed

- Rewrote `docs/philosophy.md`, `docs/ARCHITECTURE.md`, and `docs/helpers.md` for readability, aligned to their Diátaxis type; corrected over-strong claims (helper callable-name vs prompt-label, the stdlib/import advantage of a real kernel, a package-path in ARCHITECTURE).
- Replaced the shipped `shell()`/`edit()` helpers with plain Python (shell and file IO are native to the REPL) and no longer seed helpers on install.
- Consolidated the execute prompt into a pure contract (`prompt.ts`) plus a thin adapter (`tool-meta.ts`).
- Split the preview logic into single-concern `preview/` modules.
- Normalized all comments to one-line `---` / `# ---` style.

### Fixed

- Kernel startup race: `KernelClient.start` now polls `readConnectionFile` until it parses as valid JSON instead of returning the instant the file exists (`Unexpected EOF`).
- Helpers dir resolved consistently via `os.homedir()` on both the kernel and prompt sides.
- `jupyter_client` no longer a direct dependency (the host is the ZMTP client; it arrives transitively via `ipykernel`).
- Corrected the timeout guidance posture for shell calls.

### Removed

- The custom `ls()`/`help()` discovery intrinsics; the model reads the namespace via plain `globals()`.
- The `config.json` surface and the `helpersDir`/`pythonPath`/`timeoutMs` options; helpers dir and venv are fixed under `~/.pi/agent/pi-repl/`.
- The Python guest middleware (`guest.py`) and its fd3 protocol; the host now speaks ZMTP 3.0 directly to an `ipykernel` subprocess.

## [0.1.1] - 2026-08-09

### Added

- `help()` returns the real signature from the live function via `inspect.signature`.
- Toolbox loader renders `helper_description` verbatim, with no signature parsing from `def` lines.
- `bash()` helper extended with env, stdin, cwd, and timeout.
- Auto-built evaluator venv on install and the `--repl` activation flag.

### Changed

- Reframed the `execute` tool as a notebook-style REPL; shell via `!cmd`/`%%bash`, output capture via `subprocess`.
- Carried the REPL doctrine on the `execute` tool instead of a custom system prompt; the function map derives from live signatures.
- Split the preview logic and the pure prompt contract; documented the unified `~/.pi/agent/pi-repl/` layout.
- Removed the dead tools-bridge and subagents stack; renamed `tools/` → `toolbox/`.

### Fixed

- Cell timeouts reported as errors instead of silently succeeding; snapshot and restore get their own window.
- Serialized a concurrent first-engine build; torn down a boot-timeout child; capped the live stream feed.
- Replaced the per-cell wall-clock cap with a silence watchdog; `bash()` kills its process group on timeout.
- Recovered the kernel when a cell is aborted; a failed snapshot no longer overwrites the last good one; guest-side output capped so a runaway print cannot balloon memory.
- Host tolerates the guest's JSON frame format.
- Stripped ANSI color from output and tracebacks.

---

See docs/ARCHITECTURE.md for the design and `docs/` for how-to material.