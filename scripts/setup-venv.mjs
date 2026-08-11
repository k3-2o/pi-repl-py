#!/usr/bin/env node
/**
 * postinstall: build the stable per-user Python venv the guest evaluator needs
 * and seed the user's ONE helpers dir with the default shell/edit blocks.
 *
 * The guest (src/engine/guest.py) runs a real ipykernel, which requires
 * `ipykernel` + `jupyter_client` installed in a Python environment. When this
 * is installed as a pi package there is no repo-local `.venv` (gitignored and
 * excluded from the npm tarball), so we create one at a stable path the engine
 * also knows about:
 *
 *   ~/.pi/agent/pi-repl/venv/bin/python3
 *
 * HELPERS live ONLY in the user-owned config dir:
 *
 *   ~/.pi/agent/pi-repl/helpers/
 *
 * There is no helper/config folder anywhere in this package (no
 * src/engine/helpers, no templates/). The default shell.py + edit.py content is
 * emitted here; on install the dir is created if missing and the two files
 * written in — only the ones absent are created, so a file the user edited is
 * never clobbered. Once seeded, this embedded copy is discarded; the helpers
 * dir is the only abode such a file ever has on disk.
 *
 * Failures are non-fatal: if there's no system python3 or no network we print a
 * clear notice and let the engine fall back to '$PYTHON' or 'python3' at runtime.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENV_DIR = join(homedir(), ".pi", "agent", "pi-repl", "venv");
const PY = join(VENV_DIR, "bin", "python3");
const DEPS = ["ipykernel", "jupyter_client"];
const HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

function log(m) {
  process.stdout.write(`[pi-repl] ${m}\n`);
}
function warn(m) {
  process.stderr.write(`[pi-repl] warning: ${m}\n`);
}

function findSystemPython() {
  for (const cand of ["python3", "python"]) {
    try {
      execSync(`${cand} --version`, { stdio: "ignore" });
      return cand;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- default helpers
// String.raw keeps Python's backslashes literal. The source avoids backticks in
// comments/docstrings so the templates carry no JS string delimiters.
const DEFAULT_HELPERS = {
  "shell.py": String.raw`# shell — a low-power block that owns shell's murky part.
#
# It is NOT a tool. It decides none of the work — not the command, not the
# arguments, not how long to wait, not what the output means. It only makes the
# risky subprocess part safe — a command runs in its own process group and, on
# timeout, the WHOLE group is killed, so a hung command can't leave orphaned
# children eating CPU after the cell returns. That murky plumbing is all it
# takes; everything else belongs to the code that writes the with block.

helper_description = """shell — a low-power block: a with shell() as run: block whose only
job is the fragile subprocess part.
It is NOT a tool that does your job. Commands run in their own process group;
on timeout the whole group is killed, so a hung command can't leave orphaned
children. You decide the command, the arguments, the timeout (pass a GENEROUS
timeout= for long-running installs or builds — the evaluator's watchdog backs
it), and you do all the parsing and decisions on the structured result.
Instead of: subprocess.run(cmd, shell=True) with hand-rolled process-group setup,
a killpg on timeout, and fiddly capture flags — this block owns that plumbing.
Usage:
    with shell() as run:
        r = run("git log --oneline -5", timeout=30)
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                print(line)"""

import os as _os
import signal as _sig
import subprocess as _sp


class _Result:
    """A structured command outcome; no raw text plumbing at the caller."""

    __slots__ = ("args", "returncode", "stdout", "stderr")

    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def __repr__(self):
        return f"_Result returncode={self.returncode} (out {len(self.stdout)}B/err {len(self.stderr)}B)"


def _kill_group(proc):
    """Kill the whole process group of a child (its shell AND any grandchildren)."""
    try:
        _os.killpg(_os.getpgid(proc.pid), _sig.SIGKILL)
    except Exception:
        pass


def _run(command, cwd=None, env=None, input=None, timeout=None):
    """Run a command in a fresh subshell; return a _Result. On timeout, kill the group."""
    merged = dict(_os.environ)
    if env:
        merged.update(env)
    with _sp.Popen(
        command,
        shell=True,
        stdin=_sp.PIPE,
        stdout=_sp.PIPE,
        stderr=_sp.PIPE,
        text=True,
        cwd=cwd,
        env=merged,
        # fresh session => the shell + its children are one group a timeout can reap
        start_new_session=_os.name == "posix",
    ) as proc:
        try:
            stdout, stderr = proc.communicate(input=input, timeout=timeout)
        except _sp.TimeoutExpired:
            _kill_group(proc)
            try:
                proc.communicate()  # drain so no zombie is left behind
            except Exception:
                pass
            raise
    return _Result(command, proc.returncode, stdout, stderr)


class shell:
    """A block-scoped shell helper; with shell() as run: then run(cmd, timeout=...)."""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        # Per-command teardown already happens inside run(); the block just gives
        # the step a local, self-contained scope marker rather than a "tool" feel.
        return False

    def __call__(self, command=None, *, cwd=None, env=None, input=None, timeout=None):
        return _run(command, cwd=cwd, env=env, input=input, timeout=timeout)

    run = __call__  # so with shell() as run: run("...") reads naturally
`,

  "edit.py": String.raw`# edit — a low-power block that owns the fragile part of editing a file.
#
# It is NOT a tool. It decides none of the work: not what to change, not the new
# text, not where. That is plain string ops on ed.text, or ed.edit(old, new) for
# a guarded single change. The block owns the murky parts that a hand-rolled
# open(path,'w') gets wrong: exact-match safety (ed.edit only fires when old is
# unique — it never edits the wrong one of several), an atomic commit (temp file
# + os.replace, so a crash leaves either the old file or the new, never a half
# one), a stale-write abort, and a printed unified diff to verify. No .bak —
# the atomic write plus your version control already cover recovery.

helper_description = """edit(path) — a with-block for small safe in-place file edits.
It is NOT a tool that does the edit for you: you choose what to change and the
new text. Read the file via ed.text; make the change with ed.edit(old, new) or
with plain string ops on ed.text. The block owns the fragile parts — ed.edit
only replaces old when it appears EXACTLY ONCE, and otherwise errors with the
line numbers (ambiguous) or the closest real text (not found); the commit is
atomic (temp file + os.replace); the file is left untouched on any failure or
exception; and a unified diff is printed so you can verify what landed.
Instead of: hand-rolled read-modify-write with open(path,'w') or a bare
str.replace with no uniqueness check — a silent multi-replace, a truncating
write, or a stale read quietly corrupts the file.
Usage:
    with edit("src/app.py") as ed:
        ed.edit("print('old', 1)", "print('new', 1)")   # guarded: must appear once
        ed.text = ed.text.replace(old, new)                # or custom string ops
        # on exit: atomic commit + printed diff (ed.quiet=True to suppress)"""

import difflib as _difflib
import os as _os
import tempfile as _tf
from pathlib import Path as _Path


def _line_numbers(text, needle):
    """1-indexed line numbers of every occurrence of needle in text."""
    positions = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        positions.append(text.count("\n", 0, idx) + 1)
        start = idx + 1
    return positions


class edit:
    def __init__(self, path, *, quiet=False):
        self.path = _Path(path)
        self.text = ""
        self.quiet = quiet
        self.diff = ""
        self.committed = False
        self._original = ""
        self._sig0 = None

    def __enter__(self):
        if self.path.exists():
            self.text = self.path.read_text(encoding="utf-8")
            st = self.path.stat()
            self._sig0 = (st.st_mtime_ns, st.st_size)
        else:
            self.text = ""
            self._sig0 = None
        self._original = self.text
        return self

    def edit(self, old, new):
        """Replace old in the current content — only when it appears exactly once.

        Raises ValueError if old is not unique (with the line numbers) or not
        present (with the closest real text), so a bad anchor is never silently
        applied to the wrong location.
        """
        if not old:
            raise ValueError("edit(): old text is empty; give the exact text to change.")
        n = self.text.count(old)
        if n == 0:
            hint = self._closest(old)
            raise ValueError(
                f"edit(): text not found in the file"
                + (f" — closest real text: {hint!r}" if hint else "")
                + ". Re-read ed.text and retry with what is actually there."
            )
        if n > 1:
            lines = ", ".join(str(i) for i in _line_numbers(self.text, old))
            raise ValueError(
                f"edit(): found {n} occurrences (lines {lines}) — the anchor is not unique. "
                "Add surrounding context so it matches once."
            )
        self.text = self.text.replace(old, new, 1)

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_type is not None:
            return False  # an error escaped the block — never touch the file
        if self.text == self._original:
            return False  # nothing changed — leave the file alone

        # stale-write guard: abort instead of clobbering a newer file on disk
        if self._sig0 is not None:
            st = self.path.stat() if self.path.exists() else None
            if st is None or (st.st_mtime_ns, st.st_size) != self._sig0:
                raise RuntimeError(
                    f"edit: {self.path} changed on disk since this block opened — "
                    f"nothing was written. Re-read the file fresh and retry."
                )

        self._atomic_write(self.text)
        self.committed = True

        # verify cheaply: emit a diff instead of forcing a full re-read
        old_lines = self._original.splitlines(keepends=True)
        new_lines = self.text.splitlines(keepends=True)
        self.diff = "".join(
            _difflib.unified_diff(old_lines, new_lines, fromfile=str(self.path) + " (old)", tofile=str(self.path))
        )
        if self.diff and not self.quiet:
            print(self.diff)
        return False

    def _atomic_write(self, text):
        """Write text to path without ever leaving a half-written file."""
        parent = str(self.path.parent) if str(self.path.parent) else "."
        fd, tmp = _tf.mkstemp(dir=parent, prefix=self.path.name + ".", suffix=".tmp")
        try:
            with _os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
                f.flush()
                _os.fsync(f.fileno())
            _os.replace(tmp, self.path)
        except BaseException:
            try:
                _os.unlink(tmp)
            except _os.error:
                pass
            raise
    def _closest(self, old):
        """Nearest real line to a not-found anchor (stdlib difflib)."""
        if not old or "\n" in old or not self.text:
            return None
        matches = _difflib.get_close_matches(old, self.text.splitlines(), n=1, cutoff=0.5)
        return matches[0] if matches else None
`,
};

function seedDefaultHelpers() {
  try {
    mkdirSync(HELPERS_DIR, { recursive: true });
    for (const [file, body] of Object.entries(DEFAULT_HELPERS)) {
      const dest = join(HELPERS_DIR, file);
      if (!existsSync(dest)) {
        writeFileSync(dest, body, "utf8");
        log(`seeded helpers dir with the default helper: ${dest}`);
      }
    }
  } catch (e) {
    warn(`could not seed the helpers dir (${e?.message ?? e}); the shell/edit blocks won't preload.`);
  }
}

function main() {
  seedDefaultHelpers();
  if (existsSync(PY)) {
    log(`venv already present at ${VENV_DIR}`);
    return;
  }
  const systemPython = findSystemPython();
  if (!systemPython) {
    warn(
      `no python3 found on PATH; could not create the evaluator venv. ` +
        `Install python3 and run '${PY.slice(-60)} -m venv' manually, or set $PYTHON to point at one.`
    );
    return;
  }
  log(`creating evaluator venv at ${VENV_DIR} (uses ${systemPython})...`);
  try {
    mkdirSync(join(VENV_DIR, ".."), { recursive: true });
    execSync(`${systemPython} -m venv ${VENV_DIR}`, { stdio: "inherit" });
    execSync(`${PY} -m pip install --upgrade pip`, { stdio: "inherit" });
    execSync(`${PY} -m pip install ${DEPS.join(" ")}`, { stdio: "inherit" });
    log("done. The pi-repl evaluator will use this venv.");
  } catch (error) {
    warn(`could not build the evaluator venv (${error && error.message ? error.message : error}). `);
    warn("You must install ipykernel and jupyter_client in that venv before the evaluator runs.");
  }
}

main();