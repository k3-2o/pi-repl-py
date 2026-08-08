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
functions in the evaluator's namespace rather than as new tool entries, so the surface the
model sees never changes while what it can do keeps growing.

Python is the evaluator language because it keeps **variables and functions** hot with no AST
rewrite (the old TS/Bun `with(proxy)` + transform dance is unnecessary), models are fluent and
efficient in it, and the data/math ecosystem (pandas, numpy, the stdlib) is what agents reach
for.

## The toolbox — configurable functions, tailored to small models

The model's stable working set is a **toolbox**: pure-Python functions loaded into *every*
kernel at boot. A weak model can use them like standard tools without recalling exact
signatures, because introspection is built in:

- `read(path)` — bounded file read.
- `write(path, content)` — write a file (unconditional).
- `edit(path, old_text, new_text)` — targeted replacement; **fails loudly** when `old_text` is
  stale instead of silently mangling an unseen file.
- `bash(cmd)` — run a shell command, return a `CompletedProcess` (`.stdout`/`.stderr`/
  `.returncode`). This is also the escape hatch for spawning processes.
- `ls()` and `help(name)` — **hard-wired** into the evaluator (not configurable) so the model
  can discover what's loaded and how to call it.

Each function lives in its own file under `src/engine/toolbox/`. Set `toolboxDir` in the
config (or `$PI_TOOLBOX_DIR`) to point at **your own folder** and replace the shipped set —
a one-file custom function loads identically into every kernel.

## What the agent gets

- **A persistent namespace.** Variables, functions, classes, and imports survive across cells,
  turns, and — via snapshots — a best-effort basis across engine restarts. Whatever cannot be
  serialised is reported by name rather than dropped silently.
- **A real IPython kernel**, not a hand-rolled `exec` loop: rich tracebacks, safe partial
  state, the standard library, and last-expression result capture.
- **Shell as values.** `bash("git log --oneline")` returns a `CompletedProcess` — access
  `.stdout`, `.stderr`, `.returncode` and branch on them, no transcript parsing.
- **Error survival.** A cell that throws reports the traceback and the *kernel keeps going* —
  the next cell can still read what was defined before the error.
- **Snapshots.** After each successful cell, the namespace is pickled (debounced) so a crash or
  a killed process loses little; a fresh evaluator revives the last snapshot.
- **Honest reset reporting.** If the evaluator restarts, a `<rlm_engine_reset>` block names
  exactly what was revived and what was lost, so the model never assumes state that isn't there.

## Install & run

Requires [Pi](https://pi.dev) and [Bun](https://bun.sh) (the extension host) and Python 3.11+
with `ipykernel` + `jupyter_client`.

```bash
just setup    # npm install + a project-local .venv with the guest deps
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
  "toolboxDir": "pi-repl-functions",
  "pythonPath": ".venv/bin/python3",
  "timeoutMs": 60000,
  "snapshotDebounceMs": 1500
}
```

`toolboxDir` points at a folder of one-function-per-`*.py` files that replaces the shipped
defaults (paths resolve relative to `~/.pi/agent`, so the above means
`~/.pi/agent/pi-repl-functions/`).

## Development

The repository gate is:

```bash
just setup     # one-time (builds .venv)
just check     # biome format+lint, bun test (host), pytest (guest)
just integration  # also runs the real host x Python-guest seam
```

- Host logic (protocol framing, prompt, render, config) is TypeScript under **bun**.
- The Python evaluator contract (`test/guest_contract.py`) is Python under **pytest**.

## Layout

```
src/engine/
  index.ts      EngineManager — host side: spawn the guest, queue, snapshots, teardown
  guest.py      THE PYTHON EVALUATOR — a real ipykernel behind the protocol
  protocol.ts   authenticated fd3 line-JSON wire (nonce)
  toolbox/      one file per function: read.py, write.py, edit.py, bash.py
src/extension/
  index.ts      registers `execute`, dormant until `--repl`
  prompt.ts     buildRlmPyPrompt — the system prompt (toolbox doctrine etc.)
  config.ts     ~/.pi/agent/pi-repl.json loader
  session-engine.ts  rebuild/restore an engine from the last snapshot
test/
  units.test.ts         host-logic (protocol, prompt, render)
  preview-core.test.ts  cell-preview
  engine.integration.test.ts   real host x Python-guest snapshot/restore
  guest_contract.py     Python evaluator contract (pytest)
```

## Scope & limits

- **Not** a sandbox beyond process isolation — the kernel runs with your user's permissions.
  The toolbox trusts the user.
- **No subagents, no `tools.*` bridge** — subagents aren't first-class; the model can spawn a
  process with `bash()`. The `tools.*` host bridge was removed.
- **Not** a huge agent framework (mesh, councils, dashboards). This is a focused "one
  persistent Python workspace."
- A live `pi --repl` interactive harness is a tracked follow-up.