# Bridge Helper

A skill that writes a project-specific `bridge.py` helper for
[pi-bridge](https://github.com/k3-2o/pi-bridge) — the extension that serves
pi's real tools (read, bash, edit) to Python in the pi-repl kernel over a local
unix socket. The helper wraps exactly the tools a project asks for, so kernel
cells can call them and get the same validated, formatted results the model
would.

## What it does

Given a request like "read and bash in this notebook", it:

1. **Reads the live catalog** from the pi-bridge socket first — no socket means
   the bridge isn't running; it stops and tells you how to start it, never
   writes a helper blind.
2. **Writes a stdlib-only helper** wrapping exactly the requested tools, with
   kwargs and types taken from the catalog's real signatures (not guessed),
   named after the project, plus a `raw()` passthrough and a `tools()` listing.
3. **Writes a connection test** beside it and runs it against the socket —
   "done" is only reported once the test is green.
4. **Reports placement** and how the kernel loads the helper (fresh session or
   `/reload`).

## Requirements

- pi-bridge running: start pi with `pi --repl` and the
  [pi-bridge extension](https://github.com/k3-2o/pi-bridge) installed
- `python3`

## Use

Copy this folder to `~/.pi/agent/skills/bridge-helper`, then in the repl say:
*write a bridge helper for read and bash.*

Manifest, install, and protocol docs: the
[pi-bridge repository](https://github.com/k3-2o/pi-bridge).
