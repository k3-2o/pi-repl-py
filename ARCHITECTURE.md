# Architecture

## Shape

Two processes. The host lives inside pi; the guest owns the Python evaluator.

```
pi
 └─ extension            registers the `execute` tool, waits for `--repl`
     └─ EngineManager    lifecycle, execution queue, output accounting, snapshots
         │  stdin   ──▶  commands (run / snapshot / restore / ping / list_names)
         │  fd 3    ◀──  protocol: ready / stream / done / snapshot_result / ...
         │  stdout  ◀──  subprocess output only
         └─ guest (python)   a real ipykernel behind the wire protocol
             └─ ipykernel    the persistent Python namespace cells execute in
```

The host is TypeScript (Node/bun); the evaluator is Python. Splitting them is what makes the
workspace survivable: a cell can wedge, exhaust, or kill the guest (or the kernel it owns)
without taking pi down, and the host always survives to report what happened.

## A cell, end to end

1. The tool hands `EngineManager.execute` the cell source over stdin.
2. The manager claims the execution slot **synchronously** before its first await, so
   concurrent callers run in submission order, never by timing.
3. The guest starts a real `ipykernel` via `jupyter_client` (a subprocess IPython kernel — no
   separate Jupyter server) on first use and keeps it for the session.
4. `kernel.execute(code)` runs the cell in that persistent kernel. **The kernel namespace
   already persists variables, functions, and imports** — no AST transform or `with(proxy)`
   is needed (Python `exec` into the IPython namespace is native REPL semantics).
5. Output is attributed to the cell and streamed back: stdout/stderr sent as `stream` frames,
   a final expression surfaced via `done.result`, and errors as a `done` with the traceback.
6. The host applies output caps, decides status, and (on `ok`) schedules a debounced snapshot.

## Invariants

These are the guarantees the engine makes. The evaluator-side ones are pinned in
`test/guest_contract.py`; host-side protocol logic in `test/units.test.ts` + preview-core.

**One cell at a time, in submission order.** One kernel; interleaved cells would make results
depend on timing rather than the program.

**Output belongs to its cell.** Every frame is tagged with the cell that produced it.

**A cell cannot report its own outcome.** Status/result/errors reach the host only through the
authenticated `fd 3` channel. A cell's output can never be parsed as protocol traffic.

**State outlives errors.** A cell that throws returns a `done` with the traceback; the kernel
keeps running, so names bound before the error remain for later cells.

**Durability is automatic and honest.** Successful cells schedule a `pickle` snapshot
(debounced). Values that cannot be pickled (live handles, some objects) are reported by name;
functions are redefined after a restore, and the reset notice says so.

**Teardown fails loudly.** Calls against a stopped engine reject immediately.

## Decisions

### Guest = a real `ipykernel` subprocess (not subinterpreters)

The evaluator is a real IPython kernel managed by `jupyter_client`. This gives a persistent
namespace, rich tracebacks, IPython idioms, and the stdlib — and it runs in its **own
process**, so a bad cell cannot corrupt the host.

We deliberately do **not** use Python 3.14's `concurrent.interpreters` subinterpreters for cell
isolation: the docs state in-process interpreters "can never be strictly isolated" and are not
a security boundary, `Interpreter.exec()` blocks the host thread, and state is *copied via
pickle, not shared*. The ecosystem (mcp-repl, repl-mcp, ipybox, RLM's `IPythonREPL`) converges
on a subprocess `ipykernel` — which is what we use.

### Cancellation = timeout → kill the kernel → restore from snapshot

A cell spinning in synchronous code can't be cooperatively interrupted in pure Python. So a
stuck cell costs the kernel: kill it, spawn a fresh one, and `restore` from the last completed
pickle snapshot. This is process-hard and simple. Durable state survives; the in-flight cell is
lost and named in a reset notice.

### The protocol is separated and authenticated

*Separation.* Protocol uses a dedicated pipe (fd 3); the guest's stdout carries only user-visible
output, so a cell printing JSON can't be mistaken for a protocol message.

*Authentication.* Every frame carries a nonce the host mints at spawn and the guest erases
from its environment before any cell runs, so agent code cannot forge a status or result.

Without both, a cell could announce its own completion — claiming success while failing.
An agent that can't trust its own results has nothing left to reason with.

### Snapshots are per-variable and best-effort

The kernel's globals are pickled entry-by-entry in one cell and returned base64; one
unserialisable value costs only itself. Restore unpickles into a fresh kernel, per-name, with
`{restored, failed}` reported. `open handles` / some modules / functions can't pickle — the
reset notice names them instead of pretending.

### Subagents return handles, not answers

`rlm.run` resolves at admission. A parent that blocked until its child finished couldn't
supervise it. Children write their final output to a file; the registry reports running /
completed / errored so the parent decides when to read. (Host logic present; end-to-end child
`pi` spawning is exercised in the smoke test.)

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `done { status: "error" }` with traceback; kernel namespace intact |
| Kernel process wedged | timeout → kill kernel subprocess → respawn fresh + restore snapshot |
| Guest process dies | pending calls settle; engine reports itself down; later calls reject |
| Host exits | guest is killed; on abrupt death the guest self-exits on stdin EOF |
| Output flood | capped per channel, truncation announced |

## Testing

- **Host (TypeScript, `bun test`):** `test/units.test.ts` (protocol framing, prompt assembly,
  render core, subagent-host registry) + `test/preview-core.test.ts` (pure cell preview).
  These are host-logic; they don't embed a JavaScript evaluator.
- **Evaluator (Python, `pytest`):** `test/guest_contract.py` drives a real guest over the wire
  protocol and asserts persistence, error-survival, output attribution, snapshot/restore,
  `list_names`, and injected helpers. This is the specification of the evaluator.
- **Gate:** `just check` = biome format+lint, then `bun test` (host) + `pytest` (guest).

The vendored pi-rlm engine/pi-tools/lifecycle/subagent suites executed *JavaScript cells* for
the old Bun guest and are not part of the gate; the Python evaluator contract replaces them.
The `tools.*` in-cell bridge and a live `pi --repl` harness are tracked follow-ups.