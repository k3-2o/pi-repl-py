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
just setup            # npm install + a project-local .venv with the guest deps

# run a session
pi --repl
```

A plain `pi` session is untouched; the extension is dormant until `--repl` is passed (or
`PI_REPL_FORCE=1`).

## Installing as a pi package

`npm install` runs a `postinstall` that creates the Python venv the evaluator needs, at a stable
per-user path (`~/.pi/agent/pi-repl/venv`). If `python3` or the network is missing, it prints a
clear notice. How the interpreter is resolved is in [docs/philosophy.md](docs/philosophy.md).

## What you get

- **A persistent namespace.** Variables, functions, imports, and data survive across cells and
  turns; snapshots preserve them across a best-effort restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop.
- **Shell as values.** `bash("git log --oneline")` returns a `CompletedProcess` you read
  `.stdout`/`.stderr`/`.returncode` on.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **An honest evaluator.** If it restarts, it names what state it could revive and what it lost, so you don't trust memory that's gone.

## The toolbox

A small set of Python functions is preloaded into every kernel and surfaced to the
model through the `execute` tool's prompt guidance (their signatures + one-line
summaries are listed there, and `ls()`/`help()` discover them at runtime), so the
model can call `read`, `write`, `edit`, and `bash` without reimplementing them.
Set `toolboxDir` to point at your own folder; its functions are loaded **in addition to** the built-ins, and a file there with the **same name** as a built-in overrides it.

Everything the extension keeps lives under one folder in your home directory:

```
~/.pi/agent/pi-repl/
  config.json   settings (toolboxDir, pythonPath, timeoutMs)
  venv/         the Python interpreter + ipykernel
  functions/    your custom toolbox functions, if any
  state/        per-session namespace snapshots
```

These functions are the evaluator's standard file-and-shell surface; the model reaches for them as its builtins and composes its own reusable tools on top.

The function list shown to the model is built when the `execute` tool is
registered, so changing the toolbox (adding/removing a file, renaming one with a
`_` prefix) needs a **session restart / `/reload`** for the prompt to reflect it —
the kernel also only loads the toolbox at boot.

- Adding a function (the file contract, docstrings, disabling): [docs/how-to-functions.md](docs/how-to-functions.md)

## Configuration

`~/.pi/agent/pi-repl/config.json` (or `$PI_REPL_CONFIG`) sets `toolboxDir`, `pythonPath`, and timeouts.
Full keys and path rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## More

- Why this design: [docs/philosophy.md](docs/philosophy.md)
- How it works, the venv, config reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## It is not

- A sandbox. The kernel runs with your permissions; the toolbox trusts you.
- A subagent framework. There are no `rlm.run` subagents; spawn a process with `bash()`.
- A pi tool-rack. It is one `execute` tool with functions inside.

## License

MIT — see [LICENSE](LICENSE).