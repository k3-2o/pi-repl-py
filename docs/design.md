# Design rationale: why a persistent Python workspace

## The bet

Most coding agents carry a toolbox of point tools: a read tool, a bash tool, an edit tool,
a search tool, each with its own schema, its own failure modes, and its own token cost to
describe. The model spends context deciding *which* tool to call, then *how* to thread one
tool's output into the next.

pi-repl makes the opposite choice: **give the model one persistent Python workspace and let it
compose the work there.** Reading, running, searching, and editing happen in code inside one
namespace. The interface stays small while the code changes to fit the task.

This project assumes an agent benefits from a REPL that keeps working state alive. It is not an
interactive prompt for a person to type into; it is long-lived working memory for the model.

## What persistence buys

A point-tool loop re-parses text at every step. The `read` tool returns a string, so the
agent pastes it back into context. The `grep` tool returns lines, so the agent re-reads
them. Every transformation is round-tripped through the transcript and billed as tokens.

In a persistent kernel that work happens once and stays put:

- a variable assigned in one cell is still there in the next cell, and the next turn;
- a function defined once is reusable for the whole session;
- `subprocess.run(...)` returns a structured result (`.returncode`, `.stdout`, `.stderr`)
  the agent branches on with normal code — no re-parsing a tool's text output.

Holding a whole file in context just to avoid re-reading it is expensive when context is scarce. The kernel lets the model load, filter,
and store in code, printing only what the current step needs.

## Why a real kernel

pi-repl does not hand-roll an `exec` loop. It drives a genuine `ipython` kernel in a
separate process. That buys four things a script string passed to `exec` cannot give:

- **rich, real tracebacks** instead of a wrapped `except`;
- **real interrupts** — a stuck cell can be interrupted mid-run without losing the session;
- **last-expression capture** (a cell's final expression becomes its result);
- **a namespace that survives errors** — a cell that throws leaves the kernel, and
  everything defined before it, intact.

The kernel is a separate process, not part of pi. This is a process boundary, not a security sandbox. A
cell that raises leaves pi answering and the namespace intact, because pi is not the process
that failed. A cell that wedges the *whole* kernel instead stops cells from running until
the next call notices the dead kernel and rebuilds it from the last completed snapshot.
Either way the result carries a `<repl_engine_reset>` notice that names what the rebuild
revived and what it lost, so the model re-verifies before trusting state that may be gone.
(How that machinery works is in `ARCHITECTURE.md`.)

## The venv as part of the design

Because the evaluator is real Python, it needs a real Python environment with `ipykernel`.
You cannot conjure that from a script; it is a hard runtime dependency.

The package's `postinstall` creates it once at a stable per-user path
(`~/.pi/agent/pi-repl/venv`), so a `pi install` normally ends with a working evaluator. If
`python3` or the network is missing at install time, `postinstall` prints a clear notice and
the host falls back to `$PYTHON` or `python3` at runtime. Updates never lose it, because the
venv lives outside the ephemeral package directory where it would vanish on every update.

The host has a fallback order for finding Python, with the project and installed environments
preferred over the system interpreter. The exact order and the reasons for it are documented in
[ARCHITECTURE.md](ARCHITECTURE.md). This keeps the design rationale here focused on why the
venv is persistent rather than on runtime lookup details.

## Trust, not a sandbox

This is deliberately **not a sandbox.** The kernel runs with your user's permissions, can
read and write anywhere you can, and helpers are trusted as written. If you need to guard
against an untrusted model, this is the wrong tool — reach for a real sandbox the way you
would for any untrusted code. The design favors a clear limitation over a false promise of safety.

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
