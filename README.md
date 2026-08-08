# pi-repl

A [pi](https://pi.dev) extension that gives the agent a single `execute` tool backed by a
**persistent Python evaluator** — a real IPython kernel that keeps variables, functions, and
imports alive across calls and turns.

Unlike a human REPL, there is no terminal or live prompt: the agent batches code into a
long-lived Python workspace and only the printed result comes back. That is the "REPL parts
that matter to an agent" — lasting state and code-as-a-workspace — without the interactive loop.

```
✓ repl · data = load_json("records.json")        · done
✓ repl · avg = sum(v["score"] for v in data)/len(data)
✓ repl · print("mean score:", round(avg, 2))     · mean score: 41.7
```

`data` is still there in cell three. Nothing was re-read, nothing was re-derived from output —
because the evaluator is still alive.

## Why one tool, why Python

A fixed tool menu is a fixed vocabulary. Here the vocabulary is Python: capabilities arrive as
functions and helpers in the evaluator's namespace rather than as new tool entries, so the
surface the model sees never changes while what it can do keeps growing.

Python is the evaluator language because:

- models are most-fluent and, per the `mame/ai-coding-lang-bench` family, most *efficient* in
  dynamic languages like Python (fewer type-annotation tokens, more training data);
- `exec(namespace)` / a real IPython kernel keeps **variables and functions** hot with no AST
  rewrite (the JS `with(proxy)` + transform dance is unnecessary);
- the data/math ecosystem (pandas, numpy, the stdlib) is what agents actually reach for.

## What the agent gets

- **A persistent namespace.** Variables, functions, classes, and imports survive across cells,
  turns, and — via snapshots — a best-effort basis across engine restarts. Whatever cannot be
  serialised is reported by name rather than dropped silently.
- **A real IPython kernel**, not a hand-rolled `exec` loop: rich tracebacks, safe partial
  state, the standard library, and last-expression result capture.
- **Shell as values.** `sh("git log --oneline")` returns a `CompletedProcess` — access
  `.stdout`, `.stderr`, `.returncode` and branch on them, no transcript parsing.
- **Error survival.** A cell that throws reports the traceback and the *kernel keeps going* —
  the next cell can still read what was defined before the error.
- **Snapshots.** After each successful cell, the namespace is pickled (debounced) so a crash or
  killed process loses little; a fresh evaluator revives the last snapshot.
- **Honest reset reporting.** If the evaluator restarts, a `<rlm_engine_reset>` block names
  exactly what was revived and what was lost, so the model never assumes state that isn't there.

## Install & run

Requires [Pi](https://pi.dev), [Bun](https://bun.sh) (the extension host runs store is still
the pi/tui JS side, even though the evaluator is Python), and a Python 3.13+ with
`ipykernel` + `jupyter_client`.

```bash
# from this clone
npm install
# prepare the Python evaluator venv (project-local)
.venv/bin/python -m pip install ipykernel jupyter_client
```

Launch — the extension is **dormant** until the flag is passed (a plain `pi` session is
untouched):

```bash
pi --repl
```

### Configuration

`~/.pi/agent/pi-repl.json` (or `$PI_REPL_CONFIG`):

```json
{
  "helpers": ["sh", "read", "write", "glob"],
  "pythonPath": ".venv/bin/python3",
  "timeoutMs": 60000,
  "snapshotDebounceMs": 1500,
  "maxDepth": 2
}
```

`helpers: []` (an explicit empty list) = a bare kernel, no injected helpers.

## Development

The gate is:

```bash
just check      # biome format+lint, bun test (host), pytest (guest)
just test       # the same suites
```

- `bun test test/units.* test/preview-core.*` — host logic (protocol framing, prompt, render
  core, subagent host registry).
- `pytest test/guest_contract.py` — the Python evaluator contract (persistence,
  error-survival, output attribution, snapshot/restore, helpers).

The *host* is TypeScript and runs tests under **bun** (matching its vendored roots); the
*guest* is Python and runs under **pytest**. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

```
src/engine/
  index.ts      EngineManager — host side: spawn the guest, queue, snapshots, teardown
  protocol.ts   authenticated fd3 line-JSON wire (nonce)
  guest.py      THE PYTHON EVALUATOR — a real ipykernel behind the protocol
src/extension/
  index.ts      registers `execute`, dormant until `--repl`
  pi-tools.ts   mounts pi's real tool defs behind a host bridge
  prompt.ts     buildRlmPyPrompt — the injected Python-idiom guidance
  config.ts     ~/.pi/agent/pi-repl.json loader
test/
  units.test.ts        host-logic (protocol, prompt, render, subagent host)
  preview-core.test.ts pure cell-preview
  guest_contract.py    Python evaluator contract (pytest)
```

## Scope & limits

- **Not** a sandbox beyond process isolation — the kernel runs with your user's permissions.
- **Not** a huge agent framework (mesh, councils, dashboards, durable actors) — that's
  pi-fabric's territory. This is the minimal focused "one persistent Python workspace."
- The `tools.*` bridge (calling pi's real file/edit tools from inside a cell) and a live
  `pi --repl` interactive harness are tracked follow-ups.