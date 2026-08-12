# Philosophy: why a persistent Python workspace

## The bet

Most coding agents carry a toolbox of point tools: a read tool, a bash tool, an edit tool,
a search tool, each with its own schema, its own failure modes, and its own token cost to
describe. The model spends context deciding *which* tool to call, then *how* to thread one
tool's output into the next.

pi-repl makes the opposite bet: **give the model one persistent Python workspace, and let it
write the composition itself.** Reading, running, searching, and editing all happen in code,
in a single living namespace. The model's interface to the world never grows — the *code* it
writes adapts instead.

This is what an agent actually wants from a "REPL". Not an interactive prompt to type into,
but long-lived working memory the model owns.

## What persistence buys

A point-tool loop re-parses text at every step. The `read` tool returns a string, so the
agent pastes it back into context. The `grep` tool returns lines, so the agent re-reads
them. Every transformation is round-tripped through the transcript and billed as tokens.

In a persistent kernel that work happens once and stays put:

- a variable assigned in one cell is still there in the next cell, and the next turn;
- a function defined once is reusable for the whole session;
- `subprocess.run(...)` returns a structured result (`.returncode`, `.stdout`, `.stderr`)
  the agent branches on with normal code — no re-parsing a tool's text output.

The savings compound for small models. Holding a whole file in context to avoid re-reading
it is expensive precisely when context is scarce. The kernel lets the model load, filter,
and store in code, printing only what the current step needs.

## Why a real kernel

pi-repl does not hand-roll an `exec` loop. It drives a genuine `ipython` kernel in a
separate process. That buys four things a script string passed to `exec` cannot give:

- **rich, real tracebacks** instead of a wrapped `except`;
- **real interrupts** — a stuck cell can be interrupted mid-run without losing the session;
- **last-expression capture** (a cell's final expression becomes its result);
- **a namespace that survives errors** — a cell that throws leaves the kernel, and
  everything defined before it, intact.

It is also an honest isolation boundary. The kernel is its own process, not part of pi. A
cell that raises leaves pi answering and the namespace intact, because pi is not the process
that failed. A cell that wedges the *whole* kernel instead stops cells from running until
the next call notices the dead kernel and rebuilds it from the last completed snapshot.
Either way the result carries a `<repl_engine_reset>` notice that names what the rebuild
revived and what it lost, so the model re-verifies before trusting state that may be gone.
(How that machinery works is in `ARCHITECTURE.md`.)

## The venv as part of the design

Because the evaluator is real Python, it needs a real Python environment with `ipykernel`.
You cannot conjure that from a script; it is a hard runtime dependency.

The package's `postinstall` creates it once, at a stable per-user path
(`~/.pi/agent/pi-repl/venv`), so a `pi install` normally ends with a working evaluator. If
`python3` or the network is missing at install time, `postinstall` prints a clear notice and
the host falls back to `$PYTHON` or `python3` at runtime. Updates never lose it, because the
venv lives outside the ephemeral package directory where it would vanish on every update.

At runtime the host resolves the interpreter in a short, fixed order:

1. the repo's own `.venv` (development)
2. a venv in the current directory (per-project)
3. the install venv at `~/.pi/agent/pi-repl/venv`
4. `$PYTHON`, then `python3` (the fallback)

The first one that exists wins. The system interpreter is the fallback, never the
assumption, because the whole tool quietly breaks if it silently runs in the wrong
environment. The tool's prompt tells the model this, so it does not leak the wrong
assumption into commands.

## Trust, not a sandbox

This is deliberately **not a sandbox.** The kernel runs with your user's permissions, can
read and write anywhere you can, and helpers are trusted as written. If you need to guard
against an untrusted model, this is the wrong tool — reach for a real sandbox the way you
would for any untrusted code. The philosophy here prefers a sharp, honest tool over a
pretend-safe one.

## What it isn't

- **A subagent framework.** There is no `repl.run`. To delegate, the model spawns a process
  with `subprocess.run` (or `!cmd` / `%%bash`).
- **A pi tool-rack.** It exposes one `execute` tool; everything else lives inside that
  workspace.
- **A replacement for your own editing and browsing tools.** It is there when the working
  style above is worth it, and dormant otherwise.

The trade-off is real and accepted: the agent pays a little more per call to hold a heavier
environment, and gets back far fewer re-reads, fewer transcript round-trips, and sharper
small-model behaviour.
