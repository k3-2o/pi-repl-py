# Working in this repo

You may well be running inside the thing this repo builds: a pi extension whose
only tool, `execute`, runs TypeScript in a persistent Bun evaluator.

Start with [README.md](README.md) for what it is and [ARCHITECTURE.md](ARCHITECTURE.md)
for how it works and why.

## The gate

```bash
bun run check      # typecheck + lint + full suite
```

Run it before reporting work complete. Not "the tests I think are relevant" —
the gate. If it cannot run, say what blocked it.

## Rules that matter here

**The contract suite is the specification.** `test/engine.contract.test.ts`
states each guarantee the evaluator makes and why. Changing engine behaviour
means changing a stated guarantee, deliberately, with the comment updated to
explain the new one. Never weaken a case to make a change pass.

**Verify against reality, not against your own summary.** Behaviour claims need
a test run or a transcript. This applies to your own work most of all: a green
suite you did not run is not a green suite.

**Read from disk before rewriting.** Files change between turns — including by
your own earlier commits. Rewriting a file from an in-context copy silently
reverts anything you have not seen. If you are restructuring a file, read it
first, every time.

**Comments explain why.** What the code does is visible in the code. Say what
would break if it were written the obvious way instead — that is the part that
does not survive in someone's head.

**Your evaluator restarts when the extension reloads.** Changes to `src/` do not
affect the session you are in until it reloads. The namespace comes back from
the snapshot; anything unserialisable does not.

## Conventions

- Tabs, 120 columns, enforced by biome. Run `bun run format`.
- Engine code (`src/engine/`) has no pi dependencies and is testable standalone.
- Extension code that needs pi's runtime is kept thin, with the logic extracted
  into a pure module beside it (`render-core.ts` next to `render.ts`).
- Commit messages name the behaviour that changed and the reason, not the files.
