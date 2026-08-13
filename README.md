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

### Termux / Android

On **Termux (Android)** the `postinstall` venv build can fail: `ipykernel` depends on
`psutil>=5.7`, and PyPI ships no Android wheel, so a source build aborts with
`platform android is not supported`. Two near-misses do **not** fix it:

- `pkg install python-psutil` — Termux's `.deb` post-install runs the same failing `pip install
  psutil`, so no usable psutil is left.
- `pip install psutil-android` — the prebuilt `.so` links `libpython3.14.so`; on an older
  Termux Python it fails with `dlopen failed: library "libpython3.14.so" not found`. It only
  works when Termux's Python matches the wheel's ABI (currently 3.14).

The reliable route is to build `psutil` from source with an Android-aware guard, then install the
venv:

```bash
# 1. show a compiler + Python headers
pkg install clang python

# 2. fetch and patch the psutil source so Android counts as Linux
curl -sL -o psutil.tar.gz https://files.pythonhosted.org/packages/source/p/psutil/psutil-7.2.2.tar.gz && tar -xzf psutil.tar.gz
cd psutil-7.2.2
sed -i 's/LINUX = sys.platform.startswith("linux")/LINUX = sys.platform.startswith(("linux", "android"))/' psutil/_common.py
python3 setup.py bdist_wheel

# 3. (re)build the evaluator venv and install the patched wheel first
python3 -m venv --clear ~/.pi/agent/pi-repl/venv
~/.pi/agent/pi-repl/venv/bin/pip install dist/psutil-7.2.2-*.whl
~/.pi/agent/pi-repl/venv/bin/pip install ipykernel

# 4. finish the package install
pi install npm:pi-repl-py

# 5. verify
~/.pi/agent/pi-repl/venv/bin/python3 -c "import psutil, ipykernel; print(psutil.__version__, ipykernel.__version__)"
```

Then `pi --repl` starts correctly because the venv already has a working `ipykernel`.

## What you get

- **A persistent namespace.** Variables, functions, imports, and data survive across cells and
  turns; snapshots preserve them across a best-effort restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop.
- **Shell and file IO as plain Python.** `!cmd` and `%%bash` run shell fire-and-forget,
  `subprocess.run(...)` brings the result back into a variable, and `open()` / `pathlib`
  read and write files. No wrapper API to learn, and nothing extra to describe to the model.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **An honest evaluator.** If it restarts, it names what state it could revive and what it lost, so you don't trust memory that's gone.

## Helpers

A **helper** is a `.py` file that gets exec'd into every kernel, so whatever it defines
(like functions, classes, constants, imports, or a module that manages a tricky piece of
complexity) is available in the workspace. Drop a file in the one helpers directory and
restart the session; e.g. `helpers/double.py` defining `def double(x)` becomes callable as
`double(...)`. It ships **empty** (shell and file IO are already plain Python), so a fresh
install preloads nothing until you add one. Each helper's `helper_description` is shown to
the model verbatim; the full contract lives in [docs/helpers.md](docs/helpers.md).

Everything the extension keeps lives under one folder in your home directory:

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      your helpers (created empty on install; every *.py loads)
  state/        per-session namespace snapshots
```

The helpers directory is fixed at `~/.pi/agent/pi-repl/helpers`. No config file.

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

MIT. See [LICENSE](LICENSE).