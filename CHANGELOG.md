# Changelog

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
