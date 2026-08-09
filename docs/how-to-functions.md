# How to write a toolbox function

A toolbox function is one `.py` file that pi-repl loads into every kernel and
surfaces to the model through the `execute` tool's prompt guidance — its
`function_description` appears **verbatim** in the prompt. The file is the
single source of truth for what the model is told: the loader parses nothing.

> **When a change shows up.** The kernel loads the toolbox at boot, and the
> `execute` tool builds its function list at registration (module load), so a
> toolbox change (add/remove a file, edit a description, rename one with a
> `_` prefix) is picked up by a **session restart / `/reload`** — not
> mid-session.

## Where functions live

By default the extension ships four (`read`, `write`, `edit`, `bash`) in
`src/engine/toolbox/`. To use your **own** set, set `toolboxDir` in your
config:

```jsonc
// ~/.pi/agent/pi-repl/config.json
{ "toolboxDir": "~/.pi/agent/pi-repl/functions" }
```

Use an absolute path or a `~`-prefixed one (`~` expands to your home). A bare
relative path resolves from the process working directory, which is not
reliable, so prefer an absolute path for a stable per-user folder. Point
`toolboxDir` at a directory and every `*.py` there is loaded **in addition
to** the shipped `read`/`write`/`edit`/`bash`. If a file in your folder has
the **same name** as a built-in (e.g. `read.py`), your version wins and the
built-in is ignored for that name.

## The anatomy of a toolbox file

Every file has three parts. Only the first two matter to the model:

```python
# pi-repl/functions/find_files.py
function_description = """find_files(pattern, root=".") — Recursively list files under root
matching a glob pattern.
Instead of: os.walk + fnmatch written by hand."""

def find_files(pattern, root="."):
    """Return a sorted list of paths under root matching the glob pattern.

    Argument notes:
      pattern - glob like "*.csv" or "test/*.py".
      root    - directory to walk; defaults to the evaluator's cwd.

    Behaviour:
      - Uses pathlib.Path.rglob; dotfiles are not matched unless the pattern
        starts with a dot.
      - Returns relative paths, so it composes with read() and edit():
        for p in find_files('*.md'): ...
    """
    import pathlib
    return sorted(str(p) for p in pathlib.Path(root).rglob(pattern))
```

| Part | What it is | Where it goes |
|---|---|---|
| `function_description` | Everything the model sees in the prompt | Prompt bullet (verbatim) |
| the `def` | The real implementation | Loaded into every kernel |
| the docstring | Deep detail: args, return, gotchas, env facts | `help()` in the kernel |

**The function name comes from the filename.** `find_files.py` loads as
`find_files`; keep the `def` name identical so nothing surprises anyone.

## Writing the description (it IS the prompt)

The description is the model's entire first impression of your function — the
loader renders it verbatim and interprets nothing, so what you write is what
the agent reads, every turn, all session.

**Rule 1: the first line is the call shape.** Start with `name(args)`, then
the one-line "what it does". This way the prompt bullet reads like a signature
even though nothing parses it:

```text
- find_files(pattern, root=".") — Recursively list files under root
  matching a glob pattern.
  Instead of: os.walk + fnmatch written by hand.
```

Keep the call shape in sync with the real `def`. If they drift, the failure
is soft — the model calls with the stale shape, gets a `TypeError`, and
`help()` shows the truth — but it's avoidable. Keep them matching.

**Rule 2: end with an "Instead of:" line naming the stdlib hand-roll.** This
is what kills the trained habit of reimplementing file/shell/search access in
raw Python. State the exact call pattern your function replaces, and the model
that was about to write it sees a better version already exists:

- Good: `Instead of: open(path).read().splitlines() — which can crash on binary and floods context.`
- Good: `Instead of: subprocess.run(cmd, shell=True, capture_output=True, text=True).`
- Bad: `Instead of: doing it manually.` — vague, names nothing, changes nothing.

**Rule 3: keep it short.** Two to five lines: call shape, what it's for,
maybe one consequence. Everything else belongs in the docstring. The
description is billed into every turn's context — every word has a per-turn
token cost.

## Writing the docstring (the kernel-side truth)

`help(name)` in the kernel prints the **real signature** (from the live
function, via `inspect.signature`) followed by the docstring. So the docstring
is where the depth lives:

- full argument notes (types, defaults, units),
- return value and error behavior,
- environment facts the model needs ("this evaluator runs in a project-local
  venv, not the system python"),
- anything non-obvious: "each bash() call runs a fresh subshell; cd does not
  carry across calls."

The docstring never appears in the prompt; it is the on-demand backstop the
model reaches for when the description isn't enough. If a description drifts,
`help()` is the mechanically truthful channel that catches it.

## Common mistakes

- **First line isn't the call shape** — the prompt bullet becomes prose
  instead of a signature; the model has no clear call form to trust.
- **Call shape doesn't match the `def`** — recoverable (see above), but
  sloppy; keep them aligned.
- **Deep detail stuffed into the description** — it bloats every turn's
  context. Move it to the docstring.
- **No docstring** — `help()` shows only a signature and "(no docstring)";
  the model loses the gotchas you knew about.
- **Top-level side effects in the file** — the whole file is exec'd into every
  kernel at boot, so keep module-level code to definitions: no prints, no
  network calls, no slow imports at module scope.
- **Filename ≠ function name** — the loader advertises the filename; mismatch
  confuses `ls()`/`help()` mapping.

## Disabling a file without deleting it

Rename the file to start with an underscore: `_test_helper.py`. The loader
**(and the execute tool's prompt guidance)** skip underscore-prefixed files,
so it never reaches the kernel or the model. Use this for scratch or internal
helpers.

## Checklist

- [ ] Filename matches the `def` name
- [ ] `function_description` starts with `name(args)`
- [ ] An `Instead of:` line names the stdlib call it replaces
- [ ] Deep detail lives in the docstring, not the description
- [ ] No top-level side effects
- [ ] Restart / `/reload` the session

## Confirming it worked

At a `pi --repl` prompt, run a cell:

```python
print(ls())            # list what's loaded
print(help('find_files'))  # REAL signature (from the live function) + docstring
```

If `find_files` shows up in `ls()` and `help` shows its true signature, it
loaded. The `execute` tool's prompt guidance also shows its
`function_description` verbatim (same call shape + summary) after the next
session restart.