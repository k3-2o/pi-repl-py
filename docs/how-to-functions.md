# How to write a helper

A **helper** is a Python function you write once that becomes available to the agent in
every `pi --repl` session. You drop a `.py` file into one folder, restart the session, and
the function is callable from the workspace — like a bookmark for code the agent keeps
reaching for.

This guide shows the smallest helper that works, then explains the three parts every
helper file has and the habits that make a helper useful.

## Prerequisites

- A working `pi --repl` session (the extension is installed — see the README).
- The helpers folder, `~/.pi/agent/pi-repl/helpers/`. It is created empty on install.

## The smallest helper

Create this file:

```python
# ~/.pi/agent/pi-repl/helpers/double.py
helper_description = """double(x) — multiply a value by two."""

def double(x):
    """Return x * 2. Works on ints, floats, and lists."""
    return x * 2
```

Restart the session (`/reload`, or relaunch `pi --repl`), then check it loaded:

```python
print([k for k in globals() if not k.startswith('_')])
# ['double', ...]

print(double(21))
# 42
```

If `double` appears in the namespace and runs, it's loaded. That is the whole loop: write
the file, restart, use it.

## How it actually works

Two things happen with the file you wrote:

1. **The kernel execs it at boot.** The file's source runs in the kernel before the first
   cell, so `def double` defines a callable `double` in the workspace. Separately, the
   filename sets the label the prompt uses to advertise it — `double.py` is listed as
   `double`. Keep the two identical (see *Common mistakes*).

2. **The model sees the description.** The `execute` tool's prompt lists each helper's
   `helper_description`, rendered **verbatim**. Nothing is parsed: the text you put between
   the triple-quotes is exactly what the model reads.

Shell and file IO are not helpers — they are already ordinary Python
(`subprocess.run`, `!cmd`, `%%bash`, `open`, `pathlib`). A helper is only worth writing for
the fragile or opaque part the model can't reliably reconstruct on its own: a `web_search`
with provider failover, a client wrapper, a conversion it keeps getting wrong.

## The three parts of a helper file

| Part | Required? | What it does | Who sees it |
|---|---|---|---|
| `def name(...)` | yes | the implementation | runs in the kernel |
| `helper_description` | no | one line the model reads first | the prompt, verbatim |
| a docstring | no | the full detail | `print(name.__doc__)` on demand |

**The function** is the implementation. Its public name must match the filename: `double.py`
exposes `double`. Keep the `def` name identical so callers and the namespace agree.

**The description** is the model's first impression. It is the only part that reaches the
prompt, and it is billed into context every turn, so it wants to be short. Two habits help
(not requirements — the loader parses nothing):

- Start with the call shape: `double(x) — multiply a value by two.`
- Add an "Instead of:" line naming the hand-rolled code it replaces, so the model reaches
  for the helper rather than rewriting the raw call. *Good:* `Instead of: subprocess.run
  with a hand-rolled kill-on-timeout.` *Weak:* `Instead of: doing it manually.`

**The docstring** holds the depth — argument types and defaults, return value, error
behaviour, environment facts ("this runs in a project-local venv, not the system Python").
It never enters the prompt. The model reads it on demand with `print(name.__doc__)` or
`help(name)` when the description is not enough.

## Common mistakes

- **Description buried in detail.** Move anything beyond the call shape and one consequence
  into the docstring. A long description bills into every turn.
- **The helper decides too much.** A helper should own the murky part (the call, the
  parsing), not the decision. If it picks the command, the routing, or the judgement, the
  model stops reasoning.
- **No docstring.** Without one, the model sees only a signature and the gotchas vanish.
- **Top-level side effects.** The file runs at boot in every kernel. Keep module-level code
  to definitions — no prints, no network, no slow imports at module scope.
- **Filename and `def` name differ.** `helpers/foo.py` exposing `def bar` confuses callers
  and the prompt. Keep them identical.

## Disable a file without deleting it

Rename it with a leading underscore (`_scratch.py`). The loader skips any file whose name
starts with `_`, so it never reaches the kernel or the prompt. Handy for scratch work.

## Checklist

- [ ] Filename matches the public `def` name
- [ ] `helper_description` is short and starts with the call shape
- [ ] Depth lives in the docstring, not the description
- [ ] No top-level side effects
- [ ] Session restarted or `/reload`-ed
- [ ] Name appears in `globals()` and the function runs
