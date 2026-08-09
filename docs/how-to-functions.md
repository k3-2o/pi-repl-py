# How to add a toolbox function

A toolbox function is one `.py` file that pi-repl loads into every kernel and
surfaces to the model through the `execute` tool's prompt guidance (its
`function_description` appears verbatim in `promptGuidelines`). Add a file, and
it shows up wherever the toolbox is read.

> **When a change shows up.** The kernel loads the toolbox at boot, and the
> `execute` tool builds its function list at registration (module load), so a
> toolbox change (add/remove a file, rename one with a `_` prefix) is picked up
> by a **session restart / `/reload`** — not mid-session.

## Where functions live

By default the extension ships four (`read`, `write`, `edit`, `bash`) in
`src/engine/toolbox/`. To use your **own** set, set `toolboxDir` in your
config:

```jsonc
// ~/.pi/agent/pi-repl/config.json
{ "toolboxDir": "~/.pi/agent/pi-repl/functions" }
```

Use an absolute path or a `~`-prefixed one (`~` expands to your home). A bare relative
path resolves from the process working directory, which is not reliable, so prefer
an absolute path for a stable per-user folder. Point `toolboxDir` at a directory and
every `*.py` there is loaded **in addition to** the shipped `read`/`write`/`edit`/`bash`.
If a file in your folder has the **same name** as a built-in (e.g. `read.py`), your
version wins and the built-in is ignored for that name.

## The file contract

Every toolbox file must:

1. have a `def` that actually implements the function, and
2. declare `function_description` — the whole model-facing text: call shape
   first, then what it does, then an `Instead of:` line naming the stdlib
   call it replaces.

A minimal, valid file:

```python
# pi-repl/functions/summarize.py
function_description = """summarize(text, limit=1) — Return a first-sentence summary of a text.
Instead of: text.split('. ') slicing done by hand."""

__all__ = ["summarize"]

def summarize(text, limit=1):
    return ". ".join(text.split(". ")[:limit]) + "."
```

That is everything. `summarize` loads into the kernel, and the `execute` tool's
prompt guidance shows the `function_description` text verbatim after the next
session restart.

## The pieces the loader reads

**The function name comes from the filename.** `web_search.py` loads as
`web_search`. The `def` inside does not need to match anything the prompt shows.

**Everything the model is told comes from `function_description` — rendered
verbatim, nothing parsed.** No signature is derived from the `def` line: parse
garbage was a real failure mode (the loader once advertised a private helper
like `_get_env(key)` as the public function), so the author's prose is the
only allowed source of truth for the prompt.

**Convention: the description's first line starts with the call shape.** Write
`name(args)` as the first thing, so the bullet the model sees reads like a
signature even though nothing parses it:

```python
function_description = """web_search(query, intent="fact") — Unified web search with silent
failover across Serper, Exa, Firecrawl, and Tavily; returns content + references.
Instead of: hand-rolling urllib/requests against one provider and hoping the key is set."""
```

That whole string becomes the `execute` tool's prompt bullet, verbatim
(continuation lines indented two spaces). The made-up call shape only drifts
if you forget to update it — soft failure, recoverable: the model calls with
the stale shape, and `help()` shows the real one.

**Prefer an "Instead of:" line.** State the stdlib call your function stands
in for — `Instead of: open(path).read()...` — so a model about to hand-roll
the same thing sees it already exists, strictly better. That kills the
reimplement instinct in one line.

**The `def` docstring is the kernel-side truth.** `help(name)` in the kernel
now leads with the REAL signature from the live function
(`inspect.signature`), then prints the docstring. Keep deep detail —
arguments, return value, venv notes, non-obvious behavior — in the docstring.
It never goes into the prompt; it is the on-demand backstop when the model
wants to verify.

## How much to document

`function_description` is the whole prompt surface: call shape first, then
the one- to three-line "what it is, and what it replaces". The docstring is
the detail: full argument notes, return value, and any non-obvious behavior,
including environment facts the model needs ("the evaluator runs in a
project-local venv, not the system python"). `help()` shows it under the real
signature.

## Disabling a file without deleting it

Rename the file to start with an underscore: `_test_helper.py`. The loader
**(and the execute tool's prompt guidance)** skip underscore-prefixed files, so
it never reaches the kernel or the model. Use this for scratch or internal
helpers.

## Good practice

- One function per file, name matches the filename.
- `function_description` starts with the call shape, then says what it's for,
  then an `Instead of:` line naming the stdlib call it replaces.
- Keep the description tight; move everything else into the docstring.
- A function that can hang (a shell call, network) should say so in its
  docstring so the model knows the trade-off.

## Confirming it worked

At a `pi --repl` prompt, run a cell:

```python
print(ls())           # list what's loaded
print(help('summarize'))  # REAL signature (from the live function) + full docstring
```

If `summarize` shows up in `ls()` and `help` shows its true signature, it
loaded. The `execute` tool's prompt guidance also shows its
`function_description` verbatim (same call shape + summary) after the next
session restart.