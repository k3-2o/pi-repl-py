---
name: helper-creation
description: "Iteratively ideate to design the right pi-repl helper with the user before building anything. A helper is reusable Python loaded into the persistent workspace at boot. This is NOT an immediate-action skill: use it to clarify intent and agree an approach before writing code. Do not blindly build; confirm with the user first. Read the shipped helpers doc first, then design with the user."
---

# Helper Creation (design, then build)

Read `~/.pi/agent/npm/node_modules/pi-repl-py/docs/helpers.md` for the full reference. The essentials below are its core; follow them.

## What a helper is

- A helper is a `.py` file loaded into the persistent workspace at kernel boot. It can define a function, class, constant, import, or configured object.
- It exists to spare the model rebuilding the same plumbing every cell.

## Where helpers live

```text
<project>/.pi/helpers/             project helpers (walked up from cwd to the git root)
~/.pi/agent/pi-repl/helpers/       global helpers (every project)
```

- Every `.py` in each dir is loaded; files starting with `_` are ignored (rename `web.py` → `_web.py` to disable).
- A project helper shadows a same-named global helper; global fills the rest.
- The loader runs at startup and does not watch the dirs. After writing a helper, ask the user to **/reload**.

## The description contract

`helper_description` is shown to the model **verbatim, every turn**. Keep it short. Answer three questions: what it provides, how to call it, one limitation to know before calling. Add an `Instead of:` line when it replaces hand-written plumbing. Put all detail — arguments, defaults, returns, errors, dependencies — in docstrings, not the description.

```python
helper_description = """double(x) — multiply a value by two."""
```

## Shape and boot

- The file executes at boot: no network, IO, prints, or expensive work at top level. Build heavy objects lazily and cache.
- Credentials from env or config at call time, never hard-code.
- Third-party deps install into `~/.pi/agent/pi-repl/venv/` and are personal; note the dependency in the description or docstring.

## The design process

Do not run off and build. Confirm each choice with the user before the first file is written.

1. **Clarify intent.** Ask what the user wants to repeat or stop rewriting.
2. **Choose the shape** (function vs object vs heavy). Show the trade-offs.
3. **Show the shape and the description, then wait.** Agree the surface before writing the file.
4. **Write the `.py` and ask the user to /reload.**

## Checklist

- [ ] User intent clarified and the shape agreed before code.
- [ ] `helper_description` present, short, answers what/how/before-call; detail in docstrings.
- [ ] No expensive top-level work at boot (lazy init for heavy objects).
- [ ] Credentials from env/config.
- [ ] File placed in `<project>/.pi/helpers/` or `~/.pi/agent/pi-repl/helpers/`, name without leading `_`.
- [ ] User asked to /reload after writing.
