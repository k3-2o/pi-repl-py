# How to add a toolbox function

A toolbox function is one `.py` file that pi-repl loads into every kernel and
lists in the system prompt. Add a file, and it shows up wherever the toolbox is
read. No global restart is needed: the loader reads the directory at session
start.

## Where functions live

By default the extension ships four (`read`, `write`, `edit`, `bash`) in
`src/engine/toolbox/`. To use your **own** set, set `toolboxDir` in your
config:

```jsonc
// ~/.pi/agent/pi-repl.json
{ "toolboxDir": "~/.pi/agent/pi-repl-functions" }
```

Use an absolute path or a `~`-prefixed one (`~` expands to your home). A bare relative
path resolves from the process working directory, which is not reliable, so prefer
an absolute path for a stable per-user folder. Point `toolboxDir` at a directory and
every `*.py` there is loaded. Note: it **replaces** the shipped defaults; you do not
get built-ins plus yours, unless you copy the built-ins into your folder too.

## The file contract

Every toolbox file must:

1. have a `def` whose signature is the real call an agent would use, and
2. may declare `function_description` (a short one-line summary shown in the
   prompt).

A minimal, valid file:

```python
# pi-repl-functions/summarize.py
function_description = """Return a first-sentence summary of a text."""

__all__ = ["summarize"]

def summarize(text, limit=1):
    return ". ".join(text.split(". ")[:limit]) + "."
```

That is everything. `summarize` loads into the kernel and the prompt shows
`summarize(text, limit=1)`.

## The two pieces the loader reads

**1. The signature comes from the `def`, not the description.**
Arguments are read from the actual `def` line rather than hand-copied into a
docstring, so the signature the model sees tracks the code for a normal
single-line signature. Change `def summarize(text,
limit=1):` to `limit=200`, and the prompt updates to match.

**2. The description, from `function_description`, optional.**
Used as the one-line summary in the prompt's toolbox list. If you omit it, the
function is still advertised (by signature), just without a one-liner.

Each file should also give the function a real docstring (the text under
`def`). That docstring is shown by `help(name)` in the kernel and carries the
deeper usage and gotchas. It does not go into the system prompt. Keep it for
details, the venv note, and edge cases.

## How much to document

`function_description` is the summary; the `def` docstring is the detail. A
good `function_description` is one line ("Run a shell command and return its
result."). A good docstring explains arguments, return value, and any
non-obvious behavior, including environment facts the model needs
("the evaluator runs in a project-local venv, not the system python").

## Disabling a file without deleting it

Rename the file to start with an underscore: `_test_helper.py`. The loader
**(and the prompt)** skip underscore-prefixed files, so it never reaches the
kernel or the model. Use this for scratch or internal helpers.

## Good practice

- One function per file, name matches the function.
- Keep `function_description` one line. Everything else goes in the docstring.
- Let the signature carry the truth; the description says what it's *for*.
- A function that can hang (a shell call, network) should say so in its
  docstring so the model knows the trade-off.

## Confirming it worked

At a `pi --repl` prompt, run a cell:

```python
print(ls())           # list what's loaded
print(help('summarize'))  # signature + full docstring details
```

If `summarize` shows up in `ls()` and `help`, it loaded. The system prompt's
`TOOLBOX` section also lists it, same first-line summary.