# Architecture

pi-repl runs in **two processes**: pi hosts the TypeScript extension, which manages a separate
Python `ipykernel` process where user code runs, speaking the standard Jupyter protocol directly
(no Python middleman, no private framing). A cell can raise or wedge the kernel without taking pi
down; the host stays answerable.

```
pi
 └─ extension (index.ts)              registers `execute`; dormant until --repl
     └─ EngineManager (src/engine/index.ts)   venv resolution, lazy spawn,
         │                                   the call queue, snapshots,
         │                                   abort grace, teardown
         └─ KernelClient (src/engine/kernel.ts)   one ipykernel subprocess
             ├─ ZMTP 3.0 (src/engine/zmtp.ts)     the wire protocol, by hand
             ├─ Jupyter session (src/engine/session.ts)   framing + HMAC + JSON
             └─ python -m ipykernel -f <connection-file>   the evaluator
```

## Why the host speaks ZMTP itself

A TypeScript host cannot load libzmq's native Node bindings (they crash `bun`), and the earlier
Python middleman (`guest.py`) that translated a private JSON protocol is gone. The host instead
implements the small slice of ZMTP 3.0 a Jupyter client needs — DEALER for shell/control, SUB for
iopub (`src/engine/zmtp.ts`). The payoff:

- **one process boundary** instead of two;
- **one standard protocol** (Jupyter) instead of a private one on top of it;
- **no invented framing** to maintain;
- **messages are authenticated with HMAC** — the host signs and verifies every message with the
  kernel's HMAC key, replacing the old nonce that guarded against false completion messages.

## The Python environment (the venv)

The evaluator is a real ipykernel, so it needs Python with `ipykernel` installed — a hard runtime
dependency (`jupyter_client` is *not* needed: the host is the client). A package install runs
`postinstall` (`scripts/setup-venv.mjs`), which builds a stable per-user venv at
`~/.pi/agent/pi-repl/venv/bin/python3` — stable because it sits outside the package dir that npm
replaces on each update. If `python3` or the network is missing at install time, it prints a
notice and the host falls back at runtime.

At spawn, `resolvePythonPath` uses exactly one interpreter: the install venv, else `$PYTHON` /
`python3`. It never auto-picks a repo or cwd `.venv` — such a venv may lack ipykernel, which
killed the kernel whenever cwd happened to contain one. The kernel starts in the session's cwd
and falls back to the host cwd if that directory is gone, so a stale cwd never prevents boot.

## The kernel client

`KernelClient.start` spawns `python -m ipykernel -f <connection-file>` (a per-run connection file
in the temp dir), connects the three channels over ZMTP, and waits for `kernel_info_reply` before
declaring the kernel ready. Cells run as standard `execute_request`s, routed by `msg_id`:

- **iopub** — output: `stream`, `execute_result`, `display_data`, `error`, plus private-MIME
  payloads for snapshot/restore/namespace data;
- **shell** — the authoritative `execute_reply` (status, ename, evalue);
- **control** — interrupts (`interrupt_request`) and shutdown.

Four protocol details have contract tests.

**A cell settles only on two messages.** The shell reply and the iopub stream travel on different
connections, so a tiny reply can beat a large output. A cell completes only when **both** the
`execute_reply` and the matching iopub `status idle` (published after every byte) arrive;
settling on the reply alone would drop output still in flight.

**Output is capped per channel and per line**, both announced with markers: channels accumulate
against `maxOutputChars` (checked within each message), and each line is capped at 4096 chars, so
one oversized line cannot own the budget while long JSON/reprs/errors pass whole.

**Cancellation is real.** An abort sends `interrupt_request`, raising a genuine
`KeyboardInterrupt`; the namespace survives. Cells wedged in C code (which ignore interrupts)
get a 20-second grace, then the kernel is killed and the next call rebuilds from the last
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

After each successful cell, a debounced snapshot pickles the kernel's `globals` entry by entry
(one un-picklable value costs only itself) and publishes it back over a private MIME payload; the
host stores it as `namespace.snapshot` under `~/.pi/agent/pi-repl/state/<session>/`.

A fresh engine restores that snapshot **in the background**: recovery is a quiet-gap job that
never runs ahead of a user cell, so a large revive does not delay the first cell; only a
mid-session rebuild (kernel death) forces the restore before the cell that found the kernel dead.
Functions and classes defined in cells are captured by source and re-executed on restore (plain
pickle cannot revive them in `__main__`); bindings that still fail are reported by name, never
dropped silently. Entries are capped per-binding and in total (128 MiB default); the file is
written via temp-file-and-rename so a crash cannot corrupt the last good copy; a binding skipped
at save time is named in the resume notice, never dropped silently, and a failed snapshot leaves
the retry gate in place (only a persisted write advances it); a periodic refresh (default 2 min, `snapshot.periodMs`, 0 disables) bounds the loss window for same-name mutations and stands down when the last snapshot exceeded 8 MiB; value entries are zlib-compressed (file format version 3 — v1/v2 files remain restorable); session dirs are
pruned to the newest 25, and dirs whose conversation file no longer exists are swept entirely —
deleting a conversation deletes its snapshots. "ephemeral" and the live session are exempt.

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
