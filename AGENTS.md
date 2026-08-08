# Working in this repo

You may well be running inside the thing this repo builds: a pi extension whose single tool,
`execute`, runs Python in a persistent `ipykernel` evaluator behind the TypeScript host.

Start with [README.md](README.md) for what it is and [ARCHITECTURE.md](ARCHITECTURE.md) for how
it works and why.

## The gate

```bash
just check      # biome format + lint, then bun test (host) + pytest (guest)
```

Run it before reporting work complete. Not "the tests I think are relevant" — the gate.

## Rules that matter here

**The contract suites are the specification.** `test/guest_contract.py` states each guarantee
the Python evaluator makes (persistence, error-survival, output attribution, snapshot/restore)
and why. `test/units.test.ts` + `test/preview-core.test.ts` pin the TypeScript host logic.
Changing evaluator behaviour means changing a stated guarantee deliberately, with the comment
updated to explain the new one. Never weaken a case to make a change pass.

**The host and guest are two languages, two test runners.** Host = TypeScript, tests under
`bun test`. Guest = Python, tests under `pytest`. A host test must not embed JavaScript cells
(the vendored engine contract/pi-tools/lifecycle/subagent suites executed JS cells for the old
Bun guest and are superseded by `test/guest_contract.py`).

**Verify against reality, not against your own summary.** The evaluator behaviour is proven by a
green pytest run against a real kernel, not by reading guest.py. Run the suite.

**Read from disk before rewriting.** Files change between turns — including by your own earlier
commits. Read before restructuring.

**Comments explain why.** What the code does is visible; say what breaks if written the obvious
way (the fd3+nonce protocol, the timeout-kill-restore cancellation, the separate process).

**The Python runtime is project-local, not in /tmp.** The venv lives in `.venv/` on a stable
path (`~/.local/share/python-runtime`), not a `/tmp` download — `/tmp` is volatile.

## Conventions

- Host: tabs, 120 cols, biome. Run `bunx biome check --write .` for fixes.
- Guest: `ruff format` / `ruff check`.
- Engine code (`src/engine/`) has no pi dependency and is testable standalone.
- Extension code that needs pi's runtime is thin, with logic extracted beside it
  (`render-core.ts` next to `render.ts`).
- Commit messages name the behaviour that changed and why, not the files.