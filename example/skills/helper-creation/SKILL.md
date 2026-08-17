---
name: helper-creation
description: "Iteratively ideate to design the right pi-repl helper with the user before building anything. A helper is any Python worth reusing, loaded into the persistent workspace at boot. This is NOT an immediate-action skill: use it to choose an approach and shape for a helper by clarifying intent, weighing options with the user, and only writing code once aligned. Covers: the build-vs-extend decision, helper 'vs' skill 'vs' venv package, object 'vs' bare function, the helper_description contract, lazy init, and third-party packages."
compatibility: "Applies to pi-repl. Helpers live in ~/.pi/agent/pi-repl/helpers/; packages install into the venv at ~/.pi/agent/pi-repl/venv."
---

# Helper Creation (design, then build)

Design a helper *with* the user before writing code. The failure this skill prevents is building
something the user did not ask for or does not understand. Treat it as **iterative ideation**: a
series of small choices, each surfaced to the user and confirmed, before a single file is written.

Do not run off and build. The design process *is* the deliverable early on; code comes last.

## The process

1. **Clarify the intent. Ask what the user actually wants to repeat or stop**
   rewriting. What action or capability keeps being rebuilt? What problem are they trying to
   retire? One or two pointed questions beats a wall of hypothesising.

2. **Exercise the choice of *layer* before the shape.** Present the options, not a single idea:
   - a **helper** (reusable Python in the workspace) — right when the work is plumbing the model
     would otherwise rebuild every cell;
   - a **skill** (instructions the agent reads on-demand) — right when it is *knowledge* about how
     to do something, vs code to run;
   - a **venv package / third-party import** — right when the work already exists up to a
     maintained SDK the model can just `import`.
   The same capability can often be reached as any of the three. Name the trade-off for *this*
   goal and let the user pick.

3. **Weigh the helper's own shape** once a helper is chosen:
   - a bare **function** for a single reusable action;
   - an **object** with a few methods for a configured client;
   - heavier machinery only when genuinely hard to get right.
   Do NOT make a helper out of ordinary Python the model writes in one line.

4. **Show the shape, not the code.** Sketch the surface (the object and its methods, the
   description) and the trade-offs, and wait for the user to react before writing the file. Expect
   and welcome course-correction — the user's pushback is part of the design.

5. Only after the shape is agreed, produce the single `.py` per the mechanical notes below, then
   restart /reload.

## Mechanics (agreed shape -> done)

### Where helpers live

```text
~/.pi/agent/pi-repl/helpers/
```
- Loader reads every `.py` in that one dir (non-recursive); files starting with `_` are ignored
  (rename `web.py` -> `_web.py` to disable).
- The **filename** labels the helper in the prompt; it need not match any public name.
- Reload the session (`/reload` or a new `pi --repl`) after changing; the dir is not watched.

### The `helper_description` (do not skip)

The host shows this module-level variable to the model **verbatim, every turn**. Keep it
short; answer what it provides, how to call it, and one limitation it must know. A long description
is context burned on every call — never paste the full API here. Example:

```python
helper_description = """web — preloaded web client object for live web work.
Use web.search(query), web.read(url), web.map(url).
Instead of: writing provider requests and parsing each response by hand."""
```

### Docstrings are the on-demand detail
Put full behavior — argument details, defaults, return values, errors, dependencies — in the
helper's docstrings, not the description. Docstrings live in the Python workspace and are *not*
shown in the tool description; the model reaches them when the description is not enough:

```python
help(double)           # -> docstring + signature
print(double.__doc__)
```

### Shape and init
- Bare function for one action: `def double(x): return x * 2` -> model calls `double(21)`.
- Object for a client: define a class then an instance `client = Client()`; the model calls
  `client.search(...)`, not `client()`.
- Name the object, not the file, and document its real call shape: if `web.py` exposes `web`,
  say `web.search()` / `web.read()` — never describe it as `web()` unless that is actually a
  callable.
- The file is exec'd at **boot**: build heavy objects lazily on first call and cache, never do
  network / IO / prints at top level.

```python
_client = None
def _get():
    global _client
    if _client is None:
        from theirsdk import SDK
        _client = SDK(api_key=_load_key())
    return _client
```

### Credentials and packages
- Read keys from a config file or env at call time, never hard-code.
- Third-party deps: `~/.pi/agent/pi-repl/venv/bin/pip install -U <pkg>`; those are personal (not
  shipped with pi-repl) — note the dependency in the description or docstring. The venv is minimal
  by default (no `requests`/`numpy`/`pandas`).

## Decide what belongs
A helper owns the plumbing that is hard to get right or repeat; the model owns the judgment.
A helper that silently chooses the answer hides a decision that belongs to the user/model.

## Checklist
- [ ] User intent clarified; layer choice (helper 'vs' skill 'vs' package) surfaced and agreed.
- [ ] Shape (function vs object vs heavy) shown and accepted before code.
- [ ] `helper_description` present, short, answers what/how/before-call.
- [ ] Detail in docstrings, not the description.
- [ ] Single `.py` in `~/.pi/agent/pi-repl/helpers/`, name without leading `_`.
- [ ] No expensive top-level work at boot (lazy init for heavy objects).
- [ ] Credentials from config/env; third-party deps installed & noted.
- [ ] Reloaded after the change.
