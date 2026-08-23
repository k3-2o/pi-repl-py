# Changelog

## [0.6.8] - 2026-08-21

### Added

- Helpers can live in a project's `.pi/helpers/` directory, discovered by walking up from the working directory to the git root; the global `~/.pi/agent/pi-repl/helpers/` still applies to every project, and a project helper shadows a same-named global one.

## [0.6.7] - 2026-08-21

### Changed

- Rebuilt the execute tool prompt in pi's native shape: a single mechanical description, one-line snippet, flat guideline bullets.
- Output cap lowered to 45K so an accidental large dump is truncated early, with a marker, instead of carrying into context.

### Fixed

- Aborting a running cell no longer kills and restarts the kernel when the cell is slow to raise KeyboardInterrupt (for example C-bound work that only yields at a checkpoint): the kernel is given time to settle, and only a cell that genuinely never stops is killed as a last-resort cap.
- Helper lines render as single bullets instead of a doubled list marker in the tool prompt.

## [0.6.3] - 2026-08-21

### Changed

- Reworked the execute print guidance to frame output as a context cost the model carries forward.

## [0.6.2] - 2026-08-21

### Fixed

- An unresponsive or dead kernel no longer hangs the execution queue: a cell that swallows KeyboardInterrupt is killed after a grace window, and an unexpected kernel exit is detected so the next cell rebuilds.
- Wrapped code lines keep their source indentation on continuation rows.
- Bare Python identifiers now get a syntax color instead of rendering flat.
- Running-state spinner switched to a dot scroller at 120ms.

## [0.6.1] - 2026-08-20

### Changed

- Tightened the execute tool prompt: actionable voice and reduced section count.

## [0.6.0] - 2026-08-20

### Added

- Get-up-to-speed acclimation and output-format guidance to the execute tool prompt.
- Snapshot only fires when the namespace name-set changed, so unchanged cells skip the full pickling cost.

### Changed
- Rebuilt the execute tool prompt around result-proven output (fewer, denser sections).
- Restored shell/subprocess/timeout as its own section.

## [0.5.0] - 2026-08-19

### Added

- Ctrl+O expands a live cell stream as soon as the call starts (the tool body is established at call time, mirroring the host's bash tool) instead of waiting for the result.

### Changed

- Execute tool prompt retooled around working in the workspace and proving work by returned result.
- Web helper reads return a bounded preview/window by default; dropped the redundant markdown alias.
- Added define-once-reuse guidance and aligned the opener with the result-proven framing.

## [0.4.0] - 2026-08-18

### Added

- Skills are advertised in repl mode instead of being dropped by pi's read-gated prompt.

### Changed

- Reworked the execute tool description and snippet.

## [0.3.0] - 2026-08-17

### Added

- Kernel now always runs in the install venv (`~/.pi/agent/pi-repl/venv`), so project venvs without ipykernel can no longer shadow it.

### Fixed

- Startup no longer blocks render on the kernel revive; the engine warms up in the background.
- Kernel fallback to the host cwd when the requested session directory no longer exists, instead of dying with a missing-cwd error.

### Removed

- The `[pi-repl-restore]` startup popup; the namespace still revives silently in the background.

## [0.2.8] - 2026-08-17

### Changed

- Tightened the execute tool prompt to frame helpers as preloaded objects the model calls directly, avoiding `import` of a similarly-named package.
- Added a third-party-packages section to the helpers documentation (install into the repl venv).
- Added a helper-creation example skill (design-first, iterate with the user before writing code).
- Added an example `example/` link in the README.

## [0.2.7] - 2026-08-14

### Changed

- Capped per-line output as well as per-channel, so a single oversized line cannot consume the whole output budget.
- Tightened execute prompt guidance around targeted search, surgical edits, and minimal output.

## [0.2.6] - 2026-08-13

### Changed

- Tightened execute prompt guidance for targeted searches, surgical edits, and repository-safe changes.

## [0.2.5] - 2026-08-13

### Changed

- Clarified the README, architecture, design, helper, and Termux documentation.
- Added a provider-backed web helper example.

## [0.2.4] - 2026-08-13

### Added

- Documented the Termux/Android installation path, including the patched `psutil` build required when no compatible PyPI wheel is available.

## [0.2.3] - 2026-08-12

### Changed

- Reworked the REPL prompt around persistent workspace use, iterative execution, timeout discipline, and recovery after engine resets.

## [0.2.2] - 2026-08-12

### Fixed

- Installation now verifies that `ipykernel` is importable, repairs incomplete environments, and fails clearly when the evaluator cannot be built.

## [0.2.1] - 2026-08-12

### Changed

- Clarified that helpers may provide functions, classes, constants, imports, or reusable complex operations.
- Renamed `docs/how-to-functions.md` to `docs/helpers.md`.

## [0.2.0] - 2026-08-12

### Added

- Added timeout guidance for shell commands that may hang.

### Changed

- Simplified the REPL around native Python and a persistent `ipykernel` workspace.
- Reworked helper loading, prompt guidance, and installation configuration.
- Removed the shipped shell/edit helpers in favor of native Python workflows.

### Fixed

- Improved kernel startup, timeout, abort, snapshot, restore, output-limit, and recovery behavior.

## [0.1.1] - 2026-08-09

### Added

- Added helper discovery, evaluator environment setup, and `--repl` activation.

### Changed

- Reframed execution as a persistent notebook-style Python workspace.

### Fixed

- Improved timeout handling, process cleanup, output limits, and kernel recovery.

---

See docs/ARCHITECTURE.md for the design and `docs/` for how-to material.
