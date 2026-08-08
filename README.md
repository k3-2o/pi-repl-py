# pi-repl

A [pi](https://pi.dev) extension that hands the agent a single `execute` tool backed by a
**persistent Python evaluator**: a real `ipython` kernel that keeps variables, functions, imports,
and data alive across every call and every turn.

Unlike a shell you type into, there is no interactive prompt. The agent batches code into a
Python workspace that lives for the whole session, and only the printed result comes back. That
is the part of a REPL that matters to an agent: lasting state and code-as-a-workspace, with the
interactive loop out of the way.

```
✓ repl · data = load_json("records.json")      · done
✓ repl · avg = sum(v["score"] for v in data)/len(data)
✓ repl · print("mean score:", round(avg, 2))   · mean score: 41.7
```

`data` is still there in cell three. Nothing was re-read, nothing re-derived from output, because
the kernel is still alive.

## What problem it solves

An agent normally has a fixed menu of point tools (a read tool, a bash tool, an edit tool), and
it juggles between them, re-parsing text output and passing results by hand. Here the model works
in **one Python workspace**: state persists, functions compose, and capability grows by writing
better code instead of bolting on another tool. The interface the model sees never changes.

This is built for **weak and small models** first. The toolbox is discovered through `help()` and
`ls()`, and every function carries its own one-line description that is loaded into the prompt
automatically. The model never has to recall a signature from memory.

## Quick start

```bash
# dev (from this clone)
just setup            # npm install + a project-local .venv with the guest deps

# activate in a session
pi --repl
```

There is no other setup. A plain `pi` session is untouched; the extension stays dormant until
`--repl` is passed (or `PI_REPL_FORCE=1`).

## Install as a pi package

`npm install`-ing the tarball runs a `postinstall` step that creates the Python venv the
evaluator depends on, at a **stable per-user path**:

```
~/.pi/agent/pi-repl-venv/bin/python3
```

So a package install just works: `ipykernel` + `jupyter_client` live in that venv, not in the
ephemeral package dir where they'd vanish on update. If `python3` or the network is missing at
install time, it prints a clear notice and leaves you a path to fix it.

The interpreter is resolved in this order at runtime:

1. the repo's `.venv` (development)
2. a cwd-local `.venv` (project)
3. `~/.pi/agent/pi-repl-venv` (package install)
4. `$PYTHON` or `python3`

## What the agent gets

- **A persistent namespace.** Variables, functions, classes, imports, and data survive across
  cells and turns; snapshots carry them across a best-effort basis on restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop. Rich tracebacks, the standard
  library, last-expression capture.
- **Shell as values.** `bash("git log --oneline")` returns a `CompletedProcess` you read
  `.stdout`/`.stderr`/`.returncode` on.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **Honest resets.** If the evaluator restarts, a `<rlm_engine_reset>` block names exactly what
  was revived and what was lost.

## The toolbox (configurable functions)

A small set of Python functions is **preloaded into every kernel** and listed in the prompt:

```
read(path, offset=1, limit=None)   Read a file, optionally a slice.
write(path, content)               Write a file wholesale.
edit(path, old_text, new_text)     Replace text; fails if old_text is stale.
bash(command, cwd=None)            Run a shell command; returns CompletedProcess.
```

Each lives in its own file under `src/engine/toolbox/`. Set `toolboxDir` in the config to point
at **your own folder** and the files there load identically. A one-file function appears in the
kernel and the prompt automatically.

- How to add a function (the file contract, docstrings, disabling):
  [docs/how-to-functions.md](docs/how-to-functions.md)
- Why a persistent Python workspace, the venv, and the tool's limits:
  [docs/philosophy.md](docs/philosophy.md)

## Configuration

`~/.pi/agent/pi-repl.json` (or `$PI_REPL_CONFIG`):

```json
{
  "toolboxDir": "~/.pi/agent/pi-repl-functions",
  "pythonPath": ".venv/bin/python3",
  "timeoutMs": 60000,
  "snapshotDebounceMs": 1500
}
```

`toolboxDir` points at a folder of one-function-per-`.py` files that replaces the shipped
defaults. Use an absolute path, or a `~`-prefixed path (`~` is expanded). A bare relative
path is resolved from the process working directory, which is not reliable, so prefer an
absolute one for a stable, per-user folder.

## Layout

```
index.ts                extension entry (loaded by pi)
src/engine/
  guest.py               the ipython-kernel evaluator behind the wire protocol
  index.ts               host: spawn the guest, snapshots, teardown
  toolbox/               one file per function: read/write/edit/bash
src/extension/
  prompt.ts              the system prompt + dynamic toolbox loader
  config.ts              ~/.pi/agent/pi-repl.json loader
test/
  units.test.ts          host-logic
  guest_contract.py      Python evaluator contract (pytest)
  engine.integration.test.ts  real host x Python-guest seam
```

## Development

The gate is one command:

```bash
just check      # biome + bun test (host) + pytest (guest)
just integration  # adds the real host x python seam
```

The host is TypeScript under `bun`. The evaluator contract is Python under `pytest`.

## It is not

- A sandbox. The kernel runs with your user's permissions. The toolbox trusts you.
- A subagent framework. There are no `rlm.run` subagents; spawn a process with `bash()`.
- A mount-that-replaces-your-tools pi tool. It is one `execute` tool with functions inside.

## License

MIT — see [LICENSE](LICENSE).