# pi-repl-py

A [pi](https://pi.dev) extension that gives the agent a single `execute` tool backed by a
**persistent Python evaluator**: a real `ipython` kernel that keeps variables, functions, imports,
and data alive across every call and turn.

There is no interactive shell. The agent sends batches of Python code to a workspace that stays
alive for the session. Only the output comes back to the conversation. This keeps state in Python
without requiring an interactive prompt.

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

Install the package from npm or directly from GitHub:

```bash
pi install npm:pi-repl-py
# or
pi install github:k3-2o/pi-repl-py
```

The install runs a `postinstall` that creates the Python venv the evaluator needs, at a stable
per-user path (`~/.pi/agent/pi-repl/venv`). If `python3` or the network is missing, it prints a
clear notice. How the interpreter is resolved is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Termux / Android

On **Termux (Android)**, the `postinstall` venv build can fail because `ipykernel` depends on
`psutil`, and PyPI does not provide a compatible Android wheel. The [Termux / Android setup guide](docs/termux.md) shows how to build `psutil` from source and finish the installation.

## What you get

- **A persistent namespace.** Variables, functions, imports, and data survive across cells and
  turns; snapshots preserve them across a best-effort restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop.
- **Shell and file IO as plain Python.** Use `!cmd` or `%%bash` for shell commands. Use
  `subprocess.run(...)` when you need the result in a variable, and use `open()` or `pathlib`
  for files. There is no extra wrapper API to learn.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **Explicit recovery.** If it restarts, pi-repl reports which state it restored and which state it lost.

## Helpers

A **helper** is a `.py` file that gets exec'd into every kernel, so whatever it defines
(like functions, classes, constants, imports, or a module that manages a tricky piece of
complexity) is available in the workspace. Drop a file in a `.pi/helpers/` directory in
your project (or `~/.pi/agent/pi-repl/helpers/` for every project) and restart the session;
e.g. `helpers/double.py` defining `def double(x)` becomes callable as `double(...)`. Global
helpers ship **empty** (shell and file IO are already plain Python), so a fresh install
preloads nothing until you add one. Project helpers shadow same-named global ones. Each
helper's `helper_description` is shown to the model verbatim; the full contract lives in
[docs/helpers.md](docs/helpers.md).

The extension keeps its runtime under one folder in your home directory:

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      global helpers (created empty on install; every *.py loads)
  state/        per-session namespace snapshots
```

Project helpers live in `<project>/.pi/helpers/` instead; both tiers are scanned with the
project one first. No config file.

Changing a helper (adding/removing a file, renaming one with a `_` prefix) needs a
**session restart / `/reload`**: the prompt list is built when `execute` is registered and
the kernel execs helpers only at boot.

## Configuration

There is deliberately no configuration file. Everything is arranged under
`~/.pi/agent/pi-repl/`: the venv, the fixed helpers dir, and the session state.
The Python interpreter is auto-resolved (the venv, else `$PYTHON`/`python3`).

## More

- Why this design: [docs/design.md](docs/design.md)
- How it works, the venv, and the kernel: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- How to write and load helpers: [docs/helpers.md](docs/helpers.md)
- Working examples you can copy: [example/](example/) — helpers under `example/helper/` and skills under `example/skills/`
- Termux / Android installation: [docs/termux.md](docs/termux.md)

## It is not

- A sandbox. The kernel runs with your permissions; the toolbox trusts you.
- A subagent framework. There is no `repl.run` API; spawn a process with `subprocess.run`.
- A pi tool-rack. It is one `execute` tool with functions inside.

## License

MIT. See [LICENSE](LICENSE).