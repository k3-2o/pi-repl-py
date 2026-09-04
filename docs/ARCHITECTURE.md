# Architecture

pi-repl runs in **three processes**: pi hosts the TypeScript extension, which manages a small
Python bridge (`bridge.py`) that owns the real `ipykernel` evaluator through `jupyter_client`.
The host and the bridge speak one tiny JSON-lines vocabulary over a stdio pipe; the bridge speaks
the standard Jupyter protocol to the kernel with ready-made libraries. A cell can raise or wedge
the kernel without taking pi down; the host stays answerable.

```
pi
 └─ extension (index.ts)              registers `execute`; dormant until --repl
     └─ EngineManager (src/engine/index.ts)   venv resolution, lazy spawn,
         │                                   the call queue, output caps,
         │                                   abort grace, teardown
         └─ KernelClient (src/engine/kernel.ts)   spawn the bridge, one JSON
             │                                   line per op, route by id
             └─ stdio pipe ─── bridge.py   owns jupyter_client + ipykernel:
                                 │          cells, streaming, snapshots,
                                 │          restore, interrupts
                                 └─ ipykernel   the evaluator
```

## Why the boundary is one pipe

An earlier iteration had the TypeScript host speak ZMTP 3.0, HMAC-sign every frame, and
re-implement the Jupyter client protocol by hand (`zmtp.ts`, `session.ts`, ~1,100 lines) because
libzmq's native bindings crash `bun`. Each layer compensated the one below it: the wire had no
auth so frames were signed; two channels raced so cells settled on a two-message protocol; the
machine could wedge so it grew eight watchdog timers. All of it is deleted.

The replacement is one stdio pipe to `bridge.py` (~250 lines), which owns everything Python-side
with ready-made libraries:

- **the file descriptor is the authentication** — the OS gives the pipe to exactly two processes;
- **one FIFO owner** — the bridge's single-threaded loop serializes every op, so ordering needs
  no protocol;
- **death is EOF plus an exit code** — no socket-liveness guessing; ipykernel also shuts itself
  down when its parent (the bridge) dies;
- **the host caps output** exactly as before, but snapshot payloads never cross the pipe — the
  bridge writes the snapshot file itself and replies with names and counts only.

## The Python environment (the venv)

The evaluator is a real ipykernel, so it needs Python with `ipykernel` installed — a hard runtime
dependency. `jupyter_client` ships with ipykernel (the bridge drives the kernel through it), and
`cloudpickle` serializes snapshots (functions and classes by value). A package install runs
`postinstall` (`scripts/setup-venv.mjs`), which builds a stable per-user venv at
`~/.pi/agent/pi-repl/venv/bin/python3` — stable because it sits outside the package dir that npm
replaces on each update. If `python3` or the network is missing at install time, it prints a
notice and the host falls back at runtime.

At spawn, `resolvePythonPath` uses exactly one interpreter: the install venv, else `$PYTHON` /
`python3`. It never auto-picks a repo or cwd `.venv` — such a venv may lack ipykernel, which
killed the kernel whenever cwd happened to contain one. The kernel starts in the session's cwd
and falls back to the host cwd if that directory is gone, so a stale cwd never prevents boot.

## The bridge

`KernelClient.start` spawns `<venv python> bridge.py` and waits for its `ready` event; the bridge
starts ipykernel through `jupyter_client`, waits for `kernel_info_reply`, and preloads each
helper in its own cell (one broken helper fails alone). Host and bridge exchange one JSON object
per line:

- **host → bridge**: `boot` (helper sources + snapshot policy), `exec`, `snapshot`, `restore`,
  `listNames`, `interrupt`, `shutdown`;
- **bridge → host**: `ready`, `stream` (cell output, streamed), `result` (a cell settles only
  once the shell reply **and** iopub idle have arrived — a tiny reply can beat a large output),
  `reply` (op results), `error`.

Failure semantics have contract tests.

**Death is immediate and truthful.** When the kernel dies, the bridge exits; the host observes
the pipe's EOF and the exit code, settles the running cell with an error, and the next call
rebuilds from the last snapshot.

**Output is capped per channel and per line**, both announced with markers: channels accumulate
against `maxOutputChars` (checked within each event), and each line is capped at 4096 chars, so
one oversized line cannot own the budget while long JSON/reprs/errors pass whole.

**Cancellation is real.** An abort makes the bridge send `interrupt_request`, raising a genuine
`KeyboardInterrupt`; the namespace survives. Cells wedged in C code (which ignore interrupts)
get a 20-second grace, then the process group is killed and the next call rebuilds from the last
snapshot.

**History is off.** IPython's `In`/`Out` retention pins every last-expression result and cannot be
reclaimed from a user cell (measured: 62 MB → 400+ MB after two bare big results, unrecoverable),
so every execute goes out with `store_history: false`, bounding the kernel to the latest result.
Results still publish over iopub: single-mode execution calls `sys.displayhook` regardless.

## Helpers loading

At boot, the kernel and the host both read the same merged helper list (project `.pi/helpers/` up
to the git root, then the global `~/.pi/agent/pi-repl/helpers/`), so what the prompt advertises is
what the kernel holds: the kernel execs each eligible `*.py` into its namespace; the host reads
the same files' `helper_description` verbatim into the tool prompt. `_`-prefixed files are
skipped by both. Merge order and shadowing are under "The fixed layout" below.

The `promptGuidelines` are built once, when `execute` is registered, and the kernel loads helpers
only at boot, so a helpers change needs a **session restart or `/reload`**.

No discovery intrinsics (`ls()` / `help()`) are injected; list the namespace with ordinary Python:

```python
[k for k in globals() if not k.startswith('_')]
```

Full contract: [helpers.md](helpers.md).

## Snapshots & honest resets

After each successful cell, the bridge pickles the kernel's `globals` entry by entry with
cloudpickle (functions and classes serialize by value; one un-picklable binding costs only
itself), zlib-compresses each payload, and writes `namespace.snapshot` (format v4) under
`~/.pi/agent/pi-repl/state/<session>/` atomically. The gate — only a persisted write marks the
namespace as saved — lives in the bridge too, and a pickling snapshot never runs ahead of a user
cell because the bridge's own loop is the queue.

A fresh engine restores that snapshot **in the background**: the revive is a quiet-gap job the
bridge runs only when its queue has been idle, so a large revive does not delay the first cell;
only a mid-session rebuild (kernel death) forces the restore before the cell that found the
kernel dead. Functions and classes revive through cloudpickle's by-value serialization;
bindings that still fail are reported by name, never dropped silently. Entries are capped
per-binding and in total (128 MiB default); the file is written via temp-file-and-rename so a
crash cannot corrupt the last good copy; a binding skipped at save time is named in the resume
notice, never dropped silently, and a failed snapshot leaves the retry gate in place (only a
persisted write advances it); a periodic refresh (default 2 min, `snapshot.periodMs`, 0
disables) bounds the loss window for same-name mutations and stands down when the last snapshot
exceeded 8 MiB; value payloads are zlib-compressed cloudpickle streams (file format version 4 —
v1/v2/v3 files remain restorable); session dirs are pruned to the newest 25, and dirs whose
conversation file no longer exists are swept entirely — deleting a conversation deletes its
snapshots. "ephemeral" and the live session are exempt. A /fork'd conversation inherits the
parent's last snapshot — copied once into the fork's own key at first start, so it resumes with
state, carries the standard reset marker on its first cell, and the human gets a dedicated fork
toast; the parent is untouched.

A revive that never completes (a poisoned pickle) is bounded by an engine restore-cell watchdog
(`PI_REPL_BOOT_TIMEOUT_MS`, default 90s): the kernel is killed and the restore marked skipped —
"wedged while reviving; skipped" — instead of hanging the queue.

The first cell's result after a revive carries a `<repl_engine_reset>` block naming what was
revived and lost, so the model re-verifies before trusting state that may be gone; because
recovery is async, that is the first cell **after the restore completes** (usually the first cell
of a resumed conversation). The human gets only a terse `ui.notify` toast, derived from the same
restore result so the two never disagree. A resumed conversation announces only when it has a
saved past; a first-ever session stays quiet.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `error` status with traceback; kernel namespace intact |
| Cell silent or wedged | the watchdog sends an `interrupt_request`; a caller abort kills the kernel only if it is still running after a 20-second grace |
| Kernel dies | the running cell settles with an error; the next call builds a fresh kernel and restores the last snapshot **before** the triggering cell |
| Host exits | `process.on("exit")` SIGKILLs live kernels (a child does not die with its parent) |
| Output flood | capped per channel, truncation announced |

## Testing

- **Host (fast):** `test/units.test.ts` covers engine orchestration, rendering, and config;
  `test/preview-core.test.ts` covers the preview logic.
- **Contract (slow):** `test/engine.integration.test.ts` boots a real kernel per engine and
  verifies persistence across cells, error survival, output attribution, helper loading,
  snapshot/restore round-trips, output caps, silence timeout, abort, and rebuilding from a
  snapshot after the kernel dies.

The gate is `just check` (Biome formatting/lint, dead-code checks, host tests); `just integration`
adds the real-kernel suite.

## The fixed layout

There is no configuration file. Most state lives under one directory in the user's home. A small
number of environment variables can still change runtime behavior, such as the silence watchdog
timeout.

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      the helpers directory; every eligible *.py loads into each kernel
  state/        per-session namespace snapshots
```

State dirs are keyed `<project-slug>__<conversation>` so two conversations that share a filename
can never share a snapshot (a pre-slug dir migrates on the owning conversation's next start), and
`EngineLifecycle.acquire` binds each engine to its conversation, tearing a foreign engine down
before building a new one — sessions cannot bleed into each other.

Helpers merge project and global dirs: `resolveHelperDirs` walks up to the git root collecting
`.pi/helpers/`, then appends the global dir; the prompt loader and the kernel's `readHelperSources`
walk the same ordered list first-seen-wins, so a project helper shadows a same-named global one
and both sides agree. No setting is needed. The per-cell silence watchdog is off by default
(`PI_REPL_TIMEOUT_MS=0`).

Boot is bounded regardless: kernel start and helpers preload are kernel cells with no deadline of
their own, and `acquire()` dedupes, so one wedged boot (an npm update swapping the venv under a
live kernel, a hanging helper import) would hang the first cell and every cell after. The
lifecycle races each boot attempt against `PI_REPL_BOOT_TIMEOUT_MS` (default 90s): a wedged
attempt is killed and retried once with the snapshot deliberately skipped — "wedged while
reviving; skipped" — and a second wedge fails loudly. The same deadline bounds a restore whose
unpickling never returns.

## Reference documentation

- Design rationale: [design.md](design.md)
- Adding a helper: [helpers.md](helpers.md)
