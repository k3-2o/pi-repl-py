---
name: bridge-helper
description: "Write a bridge.py that exposes exactly the pi-bridge tools a project needs, then prove it against the live socket before handing it over. Use when the user wants pi tools inside repl cells for a specific project, or says: write a bridge helper, bridge for this project, helper for the bridge, I want pi.read in my cells, give my notebook pi tools."
compatibility: "Requires a running pi-bridge socket (pi --repl with the pi-bridge extension) and python3."
---

# Bridge Helper

Write a small project-specific helper that calls pi's real tools over the
pi-bridge socket, then run its test. The helper wraps only the tools the project
asked for. The socket is the contract; read [references/protocol.md](references/protocol.md)
before writing any socket code.

## Procedure

1. **Read the live catalog.** Run `python3 <this skill's dir>/scripts/catalog.py`
   (resolve it the same way this SKILL.md was loaded). It prints every mounted
   tool with its real signature. No socket?
   Then the bridge is not running: tell the user to start `pi --repl` with the
   pi-bridge extension and stop. Offer to write the helper untested if they
   confirm; do not write one silently.
2. **Fix the tool set.** From the user's request, list the tools the helper
   wraps. A requested tool that is not in the catalog cannot be wrapped: say so
   and show the manifest line that would mount it
   (`~/.pi/agent/pi-bridge/tools.yml`); never edit the manifest or the engine.
3. **Write the helper.** Start from [assets/example_helper.py](assets/example_helper.py)
   as an example, not a template to stamp. Decide per project:
   - wrap exactly the requested tools as typed methods; take kwarg names and
     types from the catalog signatures, never from imagination
   - keep the connect/backoff, handshake, and one error style from the example
   - include a `raw(tool, **params)` passthrough and a `tools()` listing
   - name the kernel object after the project or the user's word for it
     (`data_ingest`, `lab_tools`) so it cannot collide with another helper;
     the example asset's `pi = _Pi()` is illustrative only
   - define `helper_description = """..."""` (triple-quoted): pi-repl-py shows it
     verbatim in the model prompt, so name the object and list the wrapped tools
   - keep it stdlib-only and as short as the tool set allows
4. **Place it.** pi-repl-py loads `*.py` helpers from, in order: nearest
   `.pi/helpers/` from cwd up to the git root, then `~/.pi/agent/pi-repl/helpers/`.
   First-seen file name wins, so project shadows global. File name must be a
   valid identifier, no leading underscore. Default to the project dir; use the
   global dir only when the user asks for it, and warn that it then loads in
   every project.
5. **Write the test beside it.** Adapt [assets/example_test.py](assets/example_test.py):
   expected tools = the wrapped set; for each wrapped tool with an obvious
   no-side-effect call, add a real roundtrip with valid params instead of
   relying on the handshake. Name the test with a leading underscore
   (`_<name>_test.py`) inside a helper dir, or keep it outside the dir
   entirely: pi-repl-py executes every valid-name `.py` in a helper dir at
   kernel start, and a running test is a dead kernel.
6. **Run the test.** `python3 <test>.py <tool...>`. Green: report placement
   (file path), how the kernel loads it (fresh session or /reload), and the
   wrapped tool list. Red: fix the helper, not the test, unless the test itself
   is wrong.

## Maintenance

[evals.md](evals.md) defines the acceptance scenarios. Re-run all three after
any change to the skill.

## Rules

- The catalog is the only source for names, kwargs, and types
- Never touch `tools.yml`, the engine, or pi's process
- Never write the helper before the catalog read succeeds (Eval 2)
- The test must exist, run, and pass before you report done
- A test file never sits in a helper dir named without a leading underscore
