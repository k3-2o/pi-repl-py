# Architecture

Two processes: the host lives inside pi and speaks the Jupyter protocol
directly to a real `ipykernel` subprocess — no middleman, no invented framing.

```
pi
 └─ extension (index.ts)              registers `execute`, dormant until --repl
     └─ EngineManager (src/engine/index.ts)   orchestration: venv resolution,
         │                                   lazy spawn, queue, snapshots,
         │                                   abort grace, teardown
         └─ KernelClient (src/engine/kernel.ts)   one ipykernel subprocess
             ├─ ZMTP 3.0 (src/engine/zmtp.ts)     the wire protocol, by hand
             ├─ Jupyter session (src/engine/session.ts)  framing + HMAC + JSON
             └─ python -m ipykernel -f <connection-file>  the evaluator
```

The host is TypeScript; the evaluator is Python in its own process. Splitting
them is what makes a bad cell survivable: a cell can raise, leak memory, or
wedge the kernel without taking pi down, and the host, being not the thing
that failed, always gets to report what happened.

## Why the host speaks ZMTP itself

The old architecture ran a Python middleman (`guest.py`) between the host and
the kernel, translating a private fd3 JSON protocol into the Jupyter protocol.
That middleman existed only because the host could not load libzmq's native
bindings (`zeromq` crashes bun). The fix was not a workaround — it was to
implement the small slice of ZMTP 3.0 a Jupyter client needs (DEALER for
shell/control, SUB for iopub; see `src/engine/zmtp.ts`). Now there is one
process boundary, one standard protocol, zero middleman, zero invented
framing, and the nonce scheme (which existed to stop a cell from forging its
own completion) is moot: the host signs and verifies every Jupyter message
with the kernel's HMAC key itself.

## The Python environment (the venv)

The evaluator is a real `ipykernel` kernel, so it needs a Python environment
with `ipykernel`. You cannot fake that with a script; it is a hard runtime
dependency. (`jupyter_client` is not needed anymore — the host is the client.)

When installed as a pi package, `npm install` runs `postinstall`
(`scripts/setup-venv.mjs`), which creates a stable per-user venv:

```
~/.pi/agent/pi-repl/venv/bin/python3
```

That path is stable across updates because it sits outside the ephemeral
package dir under `~/.pi/agent/npm`. If `python3` or the network is missing at
install time, postinstall prints a clear notice and the host falls back at
runtime.

At spawn, `resolvePythonPath` chooses the interpreter in order:

1. the repo's own `.venv` (development)
2. a cwd-local `.venv` (project)
3. `~/.pi/agent/pi-repl/venv` (package install)
4. `$PYTHON` or `python3`

The first existing one wins. The model is told (via `help()`) that it runs in a
project-local venv, not the system interpreter, so it does not leak the wrong
assumption into commands.

## The kernel client

`KernelClient.start` spawns `python -m ipykernel -f <connection-file>` with a
per-run connection file in the temp dir, connects the three channels (shell,
control, iopub) as ZMTP sockets, and waits for a `kernel_info_reply` before
declaring readiness. Cells execute as standard Jupyter `execute_request`s,
routed by `msg_id`:

- **iopub** carries the output (stream / execute_result / display_data /
  error); private-MIME display payloads carry snapshot/restore/names data.
- **shell** carries the authoritative `execute_reply` (status, ename, evalue).
- **control** carries interrupts (`interrupt_request`) and shutdown.

Two wire subtleties are load-bearing and covered by tests:

*Completion is two half-messages.* The shell reply and the iopub stream are on
different connections, so a tiny reply can beat a huge output draining on
iopub. A cell settles only when **both** the `execute_reply` and the matching
iopub `status idle` (published after every byte of output) have arrived —
settling on the reply alone would drop output.

*Output caps.* Per-channel output is accumulated with a char budget
(`maxOutputChars`); overflow is flagged per message (a single 10 MB print
overflows within one message, not only when a later message finds the budget
exhausted) and the host appends an explicit truncation marker.

Real cancellation is an `interrupt_request` on control (a genuine
`KeyboardInterrupt` in the running cell; the namespace survives). The
engine's abort grace then kills and rebuilds the kernel from the last
snapshot as a backstop for cells wedged in C code.

## Helpers loading

At boot the kernel and the host both read the SINGLE helpers directory (the
fixed `~/.pi/agent/pi-repl/helpers`; created empty on install, no default
helpers seeded). There is no shipped toolbox that merges in.

- **kernel** execs each `*.py` into its namespace, making helpers callable.
- **host** reads the same files to build the helper list on the `execute` tool's
  `promptGuidelines`, so the model sees each `helper_description` verbatim.

The loader reads each file's `helper_description = """..."""` (rendered verbatim,
no signature parsing) — the author's prose is the whole contract; the kernel's
`help(name)` shows the real object as ground truth. Since both sides read the
same directory, a helper in the prompt also exists in the kernel. A file
renamed with a `_` prefix is skipped by both. See `docs/how-to-functions.md`.

The `promptGuidelines` are built once, when the `execute` tool is registered
(module load). A helpers change therefore needs a **session restart /
`/reload`** to be reflected in the prompt — the kernel also loads helpers only
at boot.

`ls()` and `help(name)` are built into the kernel (preloaded intrinsics, not
helper files), so a bare kernel still lets the model discover what is loaded.

## Snapshots & honest resets

After each successful cell the host schedules a debounced snapshot: a private
kernel cell pickles the kernel's globals (entry-by-entry so one bad value
costs only itself) and publishes them back over a private MIME payload; the
host stores the result as `namespace.snapshot` keyed to the session file under
`~/.pi/agent/pi-repl/state/<session>/`. On a fresh engine it restores, and
whatever cannot be pickled (live handles, some objects) is reported by name.

If the evaluator restarts, the result is prefixed with a `<repl_engine_reset>`
block naming what was revived and what was lost, so the model re-verifies
before reuse rather than trusting state that is gone.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `error` status with traceback; kernel namespace intact |
| Kernel wedged | timeout → interrupt → kill kernel subprocess → spawn fresh → restore snapshot |
| Kernel dies | pending calls settle; engine reports itself down; later calls reject |
| Host exits | `process.on("exit")` SIGKILLs live kernels (a child does not die with its parent) |
| Output flood | capped per channel, truncation announced |

## Testing

- **Host (bun):** `test/units.test.ts` (engine orchestration, render, config)
  + `test/preview-core.test.ts`.
- **Contract (slow, bun):** `test/engine.integration.test.ts` boots a real
  kernel per engine and proves the guarantees the old Python contract pinned:
  persistence across cells, error-survival, output attribution, helpers
  loading, snapshot/restore round-trips, output caps, silence timeout, abort,
  and rebuild-from-snapshot after a dead kernel.

Gate: `just check` = biome (fmt + lint) + bun test (host units).
`just integration` adds the real-kernel seam.

## The fixed layout

There is no configuration file and no knobs. Everything lives under one fixed
dir in the user's home, and the default is the only option:

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      the ONE helpers dir — every *.py is loaded into every kernel
  state/        per-session namespace snapshots
```

The helpers directory is fixed at `~/.pi/agent/pi-repl/helpers` (matching the
kernel's `readHelperSources` default); there is no way to point it elsewhere,
which keeps both sides guaranteed to read the same dir. The venv is
auto-built and the interpreter auto-resolved — no setting needed. Per-cell
silence timeout defaults to off (no cap).

## Reference documentation

- Philosophy and design rationale: [docs/philosophy.md](docs/philosophy.md)
- Adding a helper: [docs/how-to-functions.md](docs/how-to-functions.md)
