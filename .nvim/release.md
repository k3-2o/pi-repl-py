# Release runbook — pi-repl-py

A step-by-step checklist for shipping a new version of `pi-repl-py` to GitHub and npm.
Follow it top to bottom; each step is gate for the next. Everything here is the exact
process that produced `0.2.0` and `0.2.1`.

> Scope note: this lives in `.vscode/`, which is gitignored, so the runbook itself is
> never published. It's a private checklist for anyone (human or model) doing a release.

## Facts about the package

- **name:** `pi-repl-py`
- **npm identity:** `k3_2o` (publish under this account — check with `npm whoami`)
- **remote:** `https://github.com/k3-2o/pi-repl-py.git`
- **version source of truth:** `package.json`; tags are `v<version>`
- **release cadence:** a published version is immutable on npm — you **must** bump to
  publish again. You cannot republish an existing version.

---

## Before you start

1. Make sure you're on `main` and have the latest:
   ```bash
   git checkout main
   git fetch origin
   git pull --ff-only
   ```
2. Decide the bump:
   - `patch` (0.2.x) — bug fixes / doc-only, no behavior change
   - `minor` (0.3.0) — new behavior or capability (the ZMTP rewrite was a minor)
   - `major` (1.0.0) — breaking
3. Confirm npm identity before you do anything irreversible:
   ```bash
   npm whoami        # must print k3_2o
   ```

---

## The full gate (prove it works first)

Run the fast gate, then the slow real-kernel suite, then a typecheck:

```bash
just check          # fmt + lint + knip + unit tests   (must be 0 fail)
just integration     # boots a real ipykernel per engine (slow, ~1 min)
just types           # bunx tsc --noEmit (0 errors)
```

If anything fails here, **stop**. The release commit must be green before you tag.

---

## The publish pre-flight (dry run)

You cannot silently publish over an existing version. Verify the package is buildable
and inspect what would ship *before* bumping:

```bash
npm publish --dry-run
```

These are good signs:
- version line shows your new version (after the bump — rerun post-bump)
- `x files` is a sane number (~24)
- **no** line like `npm error You cannot publish over the previously published versions`

What goes in the tarball is controlled by `files` in `package.json` (and `.npmignore`).
`CHANGELOG.md` ships on GitHub, **not** npm (it's `.npmignore`d).

---

## 1. Update the changelog (pi format)

`CHANGELOG.md` must follow the pi style: version-first headers, standard sections.

```markdown
## [0.2.1] - <date>

### Added / Changed / Fixed / Removed

- one terse line per bullet, no rationale essay
```

Style rules (match pi's own changelog):
- Header: `## [<version>] - YYYY-MM-DD`
- Sections only: `### Added`, `### Changed`, `### Fixed`, `### Removed`
- Each bullet is short and factual. **No "why" clauses or mini-essays** — rationale
  belongs in the commit message, not the changelog.

---

## 2. Commit any feature/doc work separately, on a clean tree

`npm version` refuses to run if the working tree is dirty. So:

```bash
git add <your files>
git commit -m "chore(docs): <what changed and why>"   # any message; keep tree clean
```

---

## 3. Bump the version (`npm version` does it all)

`npm version` edits `package.json` + `package-lock.json`, commits them, and creates the
git tag in one step. It **requires a clean working tree**:

```bash
npm version 0.2.1        # or: npm version patch | minor | major
```

Result: a commit `0.2.1` and a tag `v0.2.1`.

If you'd folded the changelog into a separate commit beforehand (recommended), the
version commit just holds the version bump. That's the clean two-commit shape.

### If you changed the last commit's content (amend + retag)

Only needed when you rewrite a release commit after tagging. Move the tag to the new
commit (`-f`):
```bash
git add <files>
git commit --amend --no-edit
git tag -f v<version> HEAD        # re-point the tag at the amended commit
git rev-parse v<version> HEAD     # both must print the SAME sha
```

> Heads-up: `npm publish --dry-run` still lists the **old** version until you bump, so
> run the dry run again after the bump to confirm it now says the new version.

---

## 4. Re-verify on the exact release commit

```bash
just check
npm publish --dry-run       # should now list your NEW version, exit 0
```

---

## 5. Push to GitHub (main + tag)

```bash
GIT_TERMINAL_PROMPT=0 git push origin main
git push origin v0.2.1
```

- If the push asks for a username (HTTPS creds), enter them once and retry — `GitHub`
  auth is not persisted, so a fresh push may prompt.
- Verify:
  ```bash
  git ls-remote origin | grep -E "refs/heads/main|refs/tags/v0.2.1"
  ```

---

## 6. Publish to npm (for real)

```bash
npm publish
```

Expect `+ pi-repl-py@<version>` at the end. This is the irreversible write.

---

## 7. Confirm both are live

```bash
# npm — resolves from the registry
npm view pi-repl-py@<version> version

# GitHub — confirm origin/main points at your release commit and is in sync
git rev-parse origin/main HEAD
git status --short --branch       # should show 0 commits ahead of origin
```

Both must succeed. You're done.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm error You cannot publish over the previously published versions: <v>` | The version is already live on npm. Bump to a new version. |
| `npm version` → `Git working directory not clean` | Commit or stash your uncommitted work first (`npm version` needs a clean tree). |
| `git push` → `could not read Username for 'https://github.com'` | No cached GitHub creds. Provide them once, then retry the push. HTTPs pushes aren't persisted. |
| Dry-run shows the OLD version | You haven't bumped yet (or didn't re-run after bumping). Re-run after `npm version`. |
| `just check` has a `0 fail` still on the bin | See output — stop the release, fix, re-gate. |