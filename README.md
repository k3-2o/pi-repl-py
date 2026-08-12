# pi-repl

A [pi](https://pi.dev) extension that gives the agent a single `execute` tool backed by a
**persistent Python evaluator**: a real `ipython` kernel that keeps variables, functions, imports,
and data alive across every call and turn.

There is no interactive shell. The agent batches code into a Python workspace that lives for the
whole session, and only the printed result comes back. That is the part of a REPL an agent wants:
lasting state and code-as-a-workspace, without the interactive loop in the way.

```
✓ repl · data = load_json("records.json")       · done
✓ repl · avg = sum(v["score"] for v in data)/len(data)
✓ repl · print("mean score:", round(avg, 2))    · mean score: 41.7
```

`data` is still there in cell three. Nothing was re-read, nothing re-derived from output, because
the kernel stayed alive.

## Quick start

```bash
# from a clone, one-time setup
just setup            # npm install + a project-local .venv with ipykernel

# run a session
pi --repl
```

A plain `pi` session is untouched; the extension is dormant until `--repl` is passed (or
`PI_REPL_FORCE=1`).

## Installing as a pi package

`npm install` runs a `postinstall` that creates the Python venv the evaluator needs, at a stable
per-user path (`~/.pi/agent/pi-repl/venv`). If `python3` or the network is missing, it prints a
clear notice. How the interpreter is resolved is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you get

- **A persistent namespace.** Variables, functions, imports, and data survive across cells and
  turns; snapshots preserve them across a best-effort restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop.
- **Shell and file IO as plain Python.** `!cmd` and `%%bash` run shell fire-and-forget,
  `subprocess.run(...)` brings the result back into a variable, and `open()` / `pathlib`
  read and write files — no wrapper API to learn, and nothing extra to describe to the model.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **An honest evaluator.** If it restarts, it names what state it could revive and what it lost, so you don't trust memory that's gone.

## Helpers

A **helper** is a Python function you preload into every kernel. Drop a file in the one
helpers directory, restart the session, and the function is callable from the workspace —
for example, `helpers/double.py` exposing `def double` becomes `double(...)`. It ships
**empty** (shell and file IO are already plain Python), so a fresh install preloads nothing
until you add one. Each helper's `helper_description` is shown to the model verbatim;
the full contract lives in [docs/how-to-functions.md](docs/how-to-functions.md).

Everything the extension keeps lives under one folder in your home directory:

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      your helpers (created empty on install; every *.py loads)
  state/        per-session namespace snapshots
```

The helpers directory is fixed at `~/.pi/agent/pi-repl/helpers` — no config file.

Changing a helper (adding/removing a file, renaming one with a `_` prefix) needs a
**session restart / `/reload`**: the prompt list is built when `execute` is registered and
the kernel execs helpers only at boot.

## Configuration

There is deliberately no configuration file. Everything is arranged under
`~/.pi/agent/pi-repl/`: the venv, the fixed helpers dir, and the session state.
The Python interpreter is auto-resolved (the venv, else `$PYTHON`/`python3`).

## More

- Why this design: [docs/philosophy.md](docs/philosophy.md)
- How it works, the venv, config reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## It is not

- A sandbox. The kernel runs with your permissions; the toolbox trusts you.
- A subagent framework. There is no `repl.run` API; spawn a process with `subprocess.run`.
- A pi tool-rack. It is one `execute` tool with functions inside.

## License

MIT — see [LICENSE](LICENSE).