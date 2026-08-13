# Helpers

Helpers are optional Python files that pi-repl loads into the persistent workspace. Use one when
code is worth reusing. A helper can also give the model a reliable wrapper instead of making it
rebuild the same plumbing in every cell.

A helper can define a function, class, constant, import, or configured object. The filename labels the helper entry shown in the prompt. It does not have to match a function
name or any other public name in the file.

## Where helpers live

```text
~/.pi/agent/pi-repl/helpers/
```

The directory is created empty when pi-repl is installed. Every `.py` file in it is loaded when the evaluator starts. Files whose names begin with `_` are ignored.

After adding, changing, renaming, or disabling a helper, run `/reload` or start a new `pi --repl` session. The running evaluator does not watch the directory for changes.

## A small function helper

Create `double.py`:

```python
helper_description = """double(x) — multiply a value by two."""


def double(x):
    """Return x * 2. Works on ints, floats, and lists."""
    return x * 2
```

Reload pi, then call it from `execute`:

```python
print(double(21))
# 42
```

The evaluator runs the file in its global namespace, so `double` is directly available. You do not register or separately install an individual helper.

## A helper can expose an object

A helper does not need to expose a function with the same name as its file. For example, `web.py` can create a configured `web` object:

```python
helper_description = """web — search, read, and map websites."""


class Web:
    def search(self, query):
        """Search the web and return normalized results."""
        raise NotImplementedError


web = Web()
```

The model calls `web.search(...)`, not `web(...)`. See [`example/helper/web.py`](../example/helper/web.py) for the full provider-backed example.

## What the model sees

A helper may define `helper_description`:

```python
helper_description = """double(x) — multiply a value by two."""
```

The host reads this value and puts it in the `execute` tool description verbatim. It is guidance for the model, not a registration mechanism or generated API. Keep it short: it
is included in the model's context on every turn.

A useful description answers three questions:

1. What does this helper provide?
2. How should the model call it?
3. What important behavior or limitation should it know before calling it?

For a helper that replaces hand-written plumbing, an `Instead of:` line can be useful:

```python
helper_description = """web — search, read, and map websites.
Use web.search(query), web.read(url), and web.map(url).
Instead of: writing provider requests and parsing each response by hand."""
```

Do not put the complete API contract in the description. Long explanations consume context on every call. Put detailed behavior in docstrings instead.

## Docstrings are on-demand detail

Docstrings stay in the Python workspace and do not appear in the tool description automatically:

```python
def double(x):
    """Return x * 2.

    Accepts numbers and lists. Raises no custom exceptions.
    """
    return x * 2
```

When the description is not enough, inspect the helper in the workspace:

```python
help(double)
print(double.__doc__)
```

Use docstrings for argument details, defaults, return values, errors, environment requirements, and side effects.

## How loading works

At startup, two parts of pi-repl read the same helper directory:

1. The kernel executes each eligible `.py` file. Its definitions become names in the Python workspace.
2. The host reads `helper_description` to build the helper guidance shown to the model.

The host does not inspect `def` lines or infer signatures from filenames. A helper does not need to define one particular symbol. The file is the unit of loading; its public names are the names it defines or imports for use in
the workspace.

Because helpers execute at kernel startup, top-level code has consequences. Definitions are fine; imports should be reasonable; network calls, prints, subprocesses, and expensive work should usually happen inside an explicit function or method call.

## Choosing what belongs in a helper

Write a helper when it owns a part of the work that is easy to get wrong or tedious to repeat:

- a web client that handles authentication, fallback, and response normalization;
- a conversion with awkward edge cases;
- a project-specific API client;
- a small collection of related operations with shared configuration.

Do not make a helper for ordinary Python that the model can write clearly in one cell. File access and subprocess work are already available through normal Python:

```python
from pathlib import Path
import subprocess

text = Path("notes.txt").read_text()
result = subprocess.run(["git", "status", "--short"], capture_output=True, text=True, check=False)
```

The helper should handle the plumbing. The model should still decide what to inspect, which sources matter, and what the evidence supports.

## Common mistakes

### Description too long

The description is repeated in the tool prompt. Put the call shape and the few facts needed to choose the helper there; put examples and edge cases in docstrings.

### Public names are unclear

If `web.py` exposes `web`, document `web.search()` and `web.read()`. Do not describe it as `web()` unless the file actually defines a callable named `web`.

### Side effects happen during loading

The file is executed before the first cell. A top-level print pollutes every new session, and a top-level network request can make startup slow or fail before the model calls anything. Constructing a lightweight object is usually fine; defer expensive work to a method.

### A changed helper is not visible

The prompt guidance and kernel namespace are established during startup. Run `/reload` after editing the file.

### A helper hides the decision

A helper can normalize responses or manage retries. For example, the web helper can hide
provider authentication and fallback. It should not silently decide which source proves a claim
or which file should be edited; those decisions belong to the model.

## Disable a helper without deleting it

Rename the file with a leading underscore:

```text
web.py → _web.py
```

The loader skips it. Rename it back and reload when you want it again.

## Checklist

- [ ] The file is in `~/.pi/agent/pi-repl/helpers/`.
- [ ] Its public names and call shapes are clear.
- [ ] `helper_description` is short enough for every-turn context.
- [ ] Detailed behavior is in docstrings.
- [ ] Top-level code has no unnecessary side effects.
- [ ] The helper keeps plumbing separate from model judgment.
- [ ] Pi was reloaded after the file changed.
