# Architecture

pi-repl runs in **two processes**. pi hosts the TypeScript extension, and the extension manages a
separate Python `ipykernel` process where user code runs. The host talks to that kernel using the
standard Jupyter protocol. There is no Python middleman and no private framing layer between them.

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

The host is TypeScript, and the evaluator is Python in a separate process. This means a cell can
raise an exception or make the kernel unusable without taking pi down. The host can still report
what happened.

## Why the host speaks ZMTP itself

The obvious way for a TypeScript host to drive an `ipykernel` is to load a ZMQ client
library. That does not work here: libzmq's native Node bindings crash `bun`. So an earlier
design put a Python middleman (`guest.py`) between the host and the kernel, translating a
private JSON protocol over a file descriptor into the real Jupyter protocol.

The current design removes the middleman. Instead of working around the missing library, the
host implements the small slice of ZMTP 3.0 that a Jupyter client needs. ZMTP is the socket
protocol used by Jupyter's channels: the host uses a DEALER socket for shell and control, and a
SUB socket for iopub (`src/engine/zmtp.ts`).
The payoff:

- **one process boundary** instead of two;
- **one standard protocol** (Jupyter) instead of a private one on top of it;
- **no invented framing** to maintain;
- **Messages are authenticated with HMAC.** The host signs and verifies Jupyter messages with
  the kernel's HMAC key. The earlier design used a nonce to prevent false completion messages;
  the standard message signature now provides that check.

## The Python environment (the venv)

The evaluator is a real `ipykernel` kernel, so it needs a Python environment with
`ipykernel` installed. That is a hard runtime dependency — you cannot fake it with a script.
(`jupyter_client` is *not* needed: the host is the client.)

When installed as a pi package, `npm install` runs `postinstall`
(`scripts/setup-venv.mjs`), which builds a stable per-user venv:

```
~/.pi/agent/pi-repl/venv/bin/python3
```

That path is stable across updates because it sits outside the package's own directory,
which npm replaces on each update. If `python3` or the network is missing at install time,
`postinstall` prints a clear notice and the host falls back at runtime.

At spawn, `resolvePythonPath` picks the interpreter in this order:

1. the repo's own `.venv` (development)
2. a venv in the current directory (per-project)
3. `~/.pi/agent/pi-repl/venv` (package install)
4. `$PYTHON`, then `python3` (the fallback)

The first one that exists wins. The tool's prompt tells the model it runs in a project-local
venv, not the system interpreter, so it does not leak the wrong assumption into commands.

## The kernel client

`KernelClient.start` spawns `python -m ipykernel -f <connection-file>` with a per-run
connection file in the temp directory, connects the three channels as ZMTP sockets, and
waits for a `kernel_info_reply` before declaring the kernel ready. Cells run as standard
Jupyter `execute_request`s, routed by `msg_id`:

- **iopub** carries the output — `stream`, `execute_result`, `display_data`, and `error`
  messages, plus private-MIME payloads that carry snapshot, restore, and namespace data.
- **shell** carries the authoritative `execute_reply` (status, ename, evalue).
- **control** carries interrupts (`interrupt_request`) and shutdown.

Two details of this protocol are important enough to have dedicated contract tests.

**A cell is not complete until two messages arrive.** The shell reply and the iopub output stream
travel on different connections, so a tiny reply can arrive before a large output has
finished draining on iopub. A cell settles only when **both** the `execute_reply` and the
matching iopub `status idle` (published after every byte of output) have arrived. Settling
on the reply alone would drop output that was still in flight.

**Output is capped per channel.** Each channel accumulates output against a character budget
(`maxOutputChars`). Overflow is flagged per message — a single 10 MB print trips the cap
within that one message, not only once a later message exhausts the budget — and the host
appends an explicit truncation marker so the model knows output was cut.

**Cancellation is real.** An abort sends an `interrupt_request` on the control channel,
which raises a genuine `KeyboardInterrupt` in the running cell; the namespace survives. As a
backstop for cells wedged in C code (which ignore interrupts), the engine's abort grace then
kills the kernel after 500 ms, and the next call rebuilds it from the last snapshot.

## Helpers loading

At boot, the kernel and the host both read **one** helpers directory — the fixed
`~/.pi/agent/pi-repl/helpers`, created empty on install with nothing seeded into it. There is
no shipped toolbox that merges in.

- **The kernel** executes each eligible `*.py` file in its namespace, so the file's definitions
  and imports become available.
- **The host** reads the same files to build the helper list shown in the `execute` tool's
  prompt, so the model sees each `helper_description` verbatim.

Both sides read the same directory, so the names described to the model come from files the
kernel also loads. A file renamed with a `_` prefix is skipped by both sides. The
`promptGuidelines` are built once, when the `execute` tool is registered, so a helpers
change needs a **session restart or `/reload`** to reach the prompt — and the kernel loads
helpers only at boot anyway.

There are no custom discovery intrinsics (`ls()` / `help()`) injected into a bare kernel.
The model discovers what is loaded by listing the namespace with ordinary Python:

```python
[k for k in globals() if not k.startswith('_')]
```

For the full helper contract — the description, the docstring, disabling — see
[helpers.md](helpers.md).

## Snapshots & honest resets

After each successful cell, the host schedules a debounced snapshot. A private kernel cell
pickles the kernel's `globals` (entry by entry, so one value that cannot be pickled costs
only itself) and publishes the result back over a private MIME payload. The host stores it as
`namespace.snapshot`, keyed to the session file under
`~/.pi/agent/pi-repl/state/<session>/`.

When a fresh engine is built, it restores that snapshot. Whatever could not be pickled —
live handles, some objects — is reported by name. If the evaluator was rebuilt mid-session,
the result is prefixed with a `<repl_engine_reset>` block that names what was revived and
what was lost, so the model re-verifies before reusing state that may be gone.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `error` status with traceback; kernel namespace intact |
| Cell silent or wedged | the watchdog sends an `interrupt_request`; a caller abort then kills the kernel after a 500 ms grace |
| Kernel dies | the running cell settles with an error; the next call builds a fresh kernel and restores the last snapshot |
| Host exits | `process.on("exit")` SIGKILLs live kernels (a child does not die with its parent) |
| Output flood | capped per channel, truncation announced |

## Testing

- **Host (fast):** `test/units.test.ts` covers engine orchestration, rendering, and config;
  `test/preview-core.test.ts` covers the preview logic.
- **Contract (slow):** `test/engine.integration.test.ts` boots a real kernel per engine and
  verifies persistence across cells, error survival, output attribution, helper loading,
  snapshot/restore round-trips, output caps, silence timeout, abort, and rebuilding from a
  snapshot after the kernel dies.

The gate is `just check` — biome (format + lint) plus the host tests. `just integration`
adds the real-kernel suite.

## The fixed layout

There is no configuration file. Most state lives under one directory in the user's home. A
small number of environment variables can still change runtime behavior, such as the silence
watchdog timeout.

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      the helpers directory — every *.py loads into every kernel
  state/        per-session namespace snapshots
```

The helpers directory is fixed at `~/.pi/agent/pi-repl/helpers` (matching the kernel's
`readHelperSources` default), so both sides are guaranteed to read the same directory. The
venv is built automatically and the interpreter resolved by the order above — no setting
needed. The per-cell silence watchdog is off by default (`PI_REPL_TIMEOUT_MS=0`: a silent
but working cell may run on).

## Reference documentation

- Design rationale: [design.md](design.md)
- Adding a helper: [helpers.md](helpers.md)
