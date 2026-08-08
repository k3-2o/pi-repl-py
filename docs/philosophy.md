# Philosophy: why a persistent Python workspace

## The bet

Most coding agents are a pile of point tools. A read tool, a bash tool, an edit
tool, a find tool, each with its own schema, its own failure modes, its own
token cost to describe. The model spends context deciding *which* tool, then
*how* the output should be threaded into the next one.

pi-repl makes the opposite bet: **give the model one persistent Python
workspace and let it write the composition itself.** Configuration, state, and
file access all happen in code, in one living namespace. The model's interface
to the world never grows — the *code* it writes adapts instead.

That is a "REPL" the way an agent actually wants one. Not an interactive
lozenge to type into, but a long-lived working memory the model owns.

## What persistence buys

A separate-tool loop re-parses text every step. `read` returns a string, the
agent pastes it, `grep` returns lines, the agent re-reads them. Every
transformation is round-tripped through the transcript and billed as tokens.

In a persistent kernel, that work happens once and stays put:

- a variable assigned in one cell is there in the next, and the next turn;
- a function defined once is reusable for the whole session;
- `bash()` returns a real `subprocess.CompletedProcess`, not a transcript
  snippet, so the agent branches on `.returncode` and slices `.stdout` with
  normal code.

The savings compound harder for small models. Holding a whole file in context
to avoid re-reading it is expensive precisely when context is scarce; the
kernel lets the model aggregate, filter, and store in code, printing only what
the current step needs.

## Why a real kernel

pi-repl does not hand-roll an `exec` loop. It drives a genuine `ipython`
kernel in a subprocess via `jupyter_client`. That buys:

- rich, real tracebacks instead of a wrapped `except`;
- the full standard library and real `import` semantics;
- last-expression capture;
- a namespace that genuinely survives errors instead of a vomit a script
  wrapping `exec`.

And it is an honest isolation boundary: the kernel is a separate process from
pi. A cell can raise, or consume memory, or spin, and pi keeps answering because
pi is not the process that failed. The host restores from the last completed
snapshot and tells the model exactly what came back in a `<rlm_engine_reset>`
notice. More in `ARCHITECTURE.md`.

## The venv as part of the design

Because the evaluator is real Python, it needs a real Python environment with
`ipykernel` + `jupyter_client`. You cannot conjure that from nothing.

The package's `postinstall` creates it once, at a stable user path
(`~/.pi/agent/pi-repl-venv`), so a `pi install` ends with a working evaluator
and updates do not lose it (the venv is outside the ephemeral package dir
where it would vanish). At runtime the host resolves the interpreter in a
short deterministic order (repo venv, cwd venv, the install venv, then
`$PYTHON`/`python3`). The system interpreter is the fallback, never the
assumption, because the whole tool quietly breaks if it silently runs in the
wrong environment. This is a fact the toolbox functions' test in `help()`
exist to keep visible.

## Trust, not a sandbox

This is deliberately **not** a sandbox. The kernel runs with your user's
permissions, can read and write anywhere you can, and the toolbox is trusted
as written. If you need to guard against an untrusted model, this is the wrong
tool: reach for a real sandbox the way you would for any untrusted user code.
The philosophy prefers a sharp, honest tool over a pretend-safe one.

## What it isn't

- A subagent framework. There is no `rlm.run`. To delegate, the model spawns
  a process with `bash()`.
- A drop-in pi-tool parcel. It exposes one `execute` tool; everything else is
  inside that workspace.
- A replacement for your own editing/browsing tools required. It is there
  when the working style above is worth it, dormant otherwise.

The trade-off is real and accepted: the agent pays a little more per-call to
hold a heavier environment, and it gets back far fewer re-reads, fewer
transcript round-trips, and sharper small-model behavior.