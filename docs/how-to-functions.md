# How to write a helper

A helper is one `.py` file in the **helpers directory** (`~/.pi/agent/pi-repl/helpers`
by default). pi-repl exec's every file there into every kernel and surfaces it to the
model through the `execute` tool's prompt — its `helper_description` appears **verbatim**
in the prompt. The file is the single source of truth for what the model is told; the
loader parses nothing.

The philosophy: helpers are **low-power building blocks**, not finished tools. A helper
owns only the fragile or opaque part the model can't reliably reconstruct (safe shell
teardown, a web endpoint it can't invent). The model does the real work — the command,
the parsing, the decisions — in code around it, and wraps recurring shapes into **its own**
helpers. Never ship a "tool" that does the model's job for it.

> **When a change shows up.** The kernel loads the helpers at boot, and the `execute`
> tool builds its list at registration, so a change (add/remove a file, edit a
> description) is picked up by a **session restart / `/reload`** — not mid-session.

## Where helpers live

There is exactly **one** helpers directory — no shipped set is merged in. Point the
config at a folder to choose it (default `~/.pi/agent/pi-repl/helpers`):

```jsonc
// ~/.pi/agent/pi-repl/config.json
{ "helpersDir": "~/.pi/agent/pi-repl/helpers" }
```

Use an absolute or `~`-prefixed path (`~` expands to home); a bare relative path is not
reliable. What's in that one directory is everything that loads — add a `.py`, edit one,
delete one, freely. `src/engine/helpers/` in the repo is only the **shipped template** the
installer copies into the helpers dir on first use; it is not a second source.

## The anatomy of a helper file

Every file has three parts; only the first reaches the prompt:

```python
# in ~/.pi/agent/pi-repl/helpers/my_step.py
helper_description = """my_step(...) — a small building block that owns one fragile part.
It decides nothing; you write the command, the conversion, the decisions around it.
Instead of: <the stdlib call this replaces>."""

def _private_helper(x):
    return x * 2        # underscore names never load, never advertise

def my_step(a, b):
    """Deep detail lives here: args, return, gotchas, env facts — shown by help()."""
    return a + b
```

| Part | What it is | Where it goes |
|---|---|---|
| `helper_description` | Everything the model sees in the prompt | Prompt bullet (verbatim) |
| the code | The real implementation | Loaded into every kernel |
| docstrings | Deep detail | `help()` in the kernel |

The public name comes from the filename: `my_step.py` loads as `my_step`; keep the `def`
name identical. Underscore-prefixed files/names are neither loaded nor advertised.

## Writing the description (it IS the prompt)

The description is the model's whole first impression — the loader renders it verbatim
and interprets nothing. This is everything it reads, every turn, all session.

**Rule 1: the first line is the call shape.** `name(args)`, or the block form for a
context-style helper (`with <name>() as x:`). Then one line on what it's for.

**Rule 2: an "Instead of:" line names the hand-roll it replaces.** This is what kills the
trained habit of rebuilding the raw stdlib call:

- Good: `Instead of: subprocess.run(cmd, shell=True) with hand-rolled kill-on-timeout.`
- Bad: `Instead of: doing it manually.` — names nothing, changes nothing.

**Rule 3: keep it short.** Call shape + one consequence is plenty, for the model. Deep
detail lives in the docstring. The description is billed into context every turn; a few
words over can be fine, a flood is a waste.

## Writing the docstring (the kernel-side truth)

`help(name)` shows the real signature plus the docstring. That's where depth lives:
argument notes (types, defaults, units), return and error behavior, environment facts
("this evaluator runs in a project-local venv, not the system python"), anything a caller
needs. The docstring never appears in the prompt; it's the on-demand backstop the model
reaches when the description isn't enough.

## Common mistakes

- **First line isn't the shape** — the bullet becomes prose with no clear call form.
- **The helper makes the model lazy** — it decides the command, the parsing, the routing.
  The helper owns the murk; reasoning stays with the caller.
- **Deep detail stuffed into the description** — bloats every turn's context; move it to
  the docstring.
- **No docstring** — `help()` shows a signature and "(no docstring)"; gotchas vanish.
- **Top-level side effects** — the file is exec'd into every kernel at boot; keep
  module-level code to definitions (no prints, no network, no slow imports at module scope).
- **Filename ≠ public name** — a mismatch confuses `ls()`/`help()` mapping.

## Disabling a file without deleting it

Rename it to a leading underscore (`_scratch.py`). The loader and the prompt skip
underscore-prefixed files, so it never reaches the kernel or the model. Great for scratch
helpers.

## Checklist

- [ ] Public name matches the filename
- [ ] `helper_description` starts with the call shape / block form
- [ ] An `Instead of:` line names the stdlib call it replaces
- [ ] It owns only the murk, not the decision
- [ ] Deep detail lives in the docstring, not the description
- [ ] No top-level side effects
- [ ] Restart / `/reload` the session

## Confirming it worked

At a `pi --repl` prompt, run a cell:

```python
print(ls())                       # list what's loaded
print(help('shell'))              # the shipped helper's real explanation
```

If `my_step` shows in `ls()` and `help` explains it, it loaded. The `execute` tool's
prompt guidance also shows its `helper_description` verbatim after the next restart.