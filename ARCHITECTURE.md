# Architecture

Two processes: the host lives inside pi, the guest owns the Python workspace.

```
pi
 └─ extension (index.ts)        registers `execute`, dormant until --repl
     └─ EngineManager (src/engine/index.ts)  spawn host: snapshots, teardown
         │  stdin  ──▶  protocol commands (run / snapshot / restore / ping)
         │  fd 3   ◀──  stream, done, snapshot_result, ...
         └─ guest.py ▶ jupyter_client ▶ a real ipython kernel (subprocess)
```

The host is TypeScript; the evaluator is Python in its own process. Splitting
them is what makes a bad cell survivable: a cell can raise, leak memory, or
wedge the guest without taking pi down, and the host, being not the thing
that failed, always gets to report what happened.

## The Python environment (the venv)

The evaluator is a real `ipython` kernel, so it needs a Python environment with
`ipykernel` + `jupyter_client`. You cannot fake that with a script; it is a
hard runtime dependency.

When installed as a pi package, `npm install` runs `postinstall`
(`scripts/setup-venv.mjs`), which creates a stable per-user venv:

```
~/.pi/agent/pi-repl-venv/bin/python3
```

That path is stable across updates because it sits outside the ephemeral
package dir under `~/.pi/agent/npm`. If `python3` or the network is missing at
install time, postinstall prints a clear notice and the host falls back at
runtime.

At spawn, `resolvePythonPath` chooses the interpreter in order:

1. the repo's own `.venv` (development)
2. a cwd-local `.venv` (project)
3. `~/.pi/agent/pi-repl-venv` (package install)
4. `$PYTHON` or `python3`

The first existing one wins. The model is told (via `help()`) that it runs in a
project-local venv, not the system interpreter, so it does not leak the wrong
assumption into commands.

## The guest

`src/engine/guest.py` uses `jupyter_client.KernelManager` to start a real
`ipykernel` subprocess (`python -m ipykernel`), keeps a blocking client
attached, and stays alive for the whole session. Cells run in that kernel via
`kc.execute(code)`, so state persists because the kernel process does.

The wire protocol rides two channels, both load-bearing:

*Separation.* Protocol traffic uses a dedicated pipe (fd 3). The guest's real
stdout/stderr carry only user output, so a cell printing JSON cannot be parsed
as a protocol message.

*Authentication.* Every frame carries a nonce the host mints at spawn and the
guest erases from its environment before any cell runs. Code inside a cell
cannot recover it. Without this, a cell could announce its own completion and
claim success while failing — an agent that cannot trust its own results has
nothing.

## Toolbox loading

At boot the guest and the host both read the toolbox directory (default
`src/engine/toolbox`, overridden by config `toolboxDir` → env `PI_TOOLBOX_DIR`).

- **guest** execs each `*.py` into the kernel namespace, making functions
  callable.
- **host** reads the same files to build the `TOOLBOX` section of the system
  prompt and the `execute` tool description.

The loader reads each file's `def (...)`: signature (authoritative) and its
`function_description = """..."""` (one-line summary, optional). Since both
sides read the same directory, function appearing in the prompt also exists in
the kernel. A file renamed with a `_` prefix is skipped by both, so a disabled
function is never advertised where it does not load. See
`docs/how-to-functions.md`.

`ls()` and `help(name)` are built into the kernel (not toolbox files), so a
bare kernel still lets the model discover what is loaded.

## Snapshots & honest resets

After each successful cell the host schedules a debounced snapshot: it asks
the guest to pickle the kernel's globals (entry-by-entry so one bad value
costs only itself), and stores that as `namespace.snapshot` keyed to the
session file. On a fresh engine it restores, and whatever cannot be pickled
(live handles, some objects) is reported by name.

If the evaluator restarts, the result is prefixed with a `<rlm_engine_reset>`
block naming what was revived and what was lost, so the model re-verifies
before reuse rather than trusting state that is gone.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `done { status: "error" }` with traceback; kernel namespace intact |
| Kernel wedged | timeout → kill kernel subprocess → spawn fresh → restore snapshot |
| Guest process dies | pending calls settle; engine reports itself down; later calls reject |
| Host exits | guest is killed; on abrupt death it self-exits on stdin EOF |
| Output flood | capped per channel, truncation announced |

## Testing

- **Host (bun):** `test/units.test.ts` (protocol, prompt, render, config) +
  `test/preview-core.test.ts`.
- **Evaluator (pytest):** `test/guest_contract.py` drives a real guest and
  asserts persistence, error-survival, output attribution, snapshots, ls/help.
- **Integration (slow):** `test/engine.integration.test.ts` boots a real
  engine + guest and proves a variable survives an engine restart.

Gate: `just check` = biome + bun test (host) + pytest (guest).
`just integration` adds the real-host seam.

## Reference documentation

- Philosophy and design rationale: [docs/philosophy.md](docs/philosophy.md)
- Adding a toolbox function: [docs/how-to-functions.md](docs/how-to-functions.md)