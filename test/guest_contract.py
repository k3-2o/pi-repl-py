"""Contract tests for the pi-repl Python guest evaluator (src/engine/guest.py).

These drive the guest over its stdin / fd3 wire protocol to verify the evaluator
guarantees the engine relied on: persistent state, error survival, output
attribution, snapshot/restore, and namespace listing.

The guest is spawned with fd 3 connected to a pipe. Because Python's `pass_fds`
renumbers descriptors in the child, we guarantee fd 3 via a small bash wrapper
(`exec 3> ...`) so the semantics match how the TS host drives it.
"""

import json
import os
import subprocess
import tempfile
import time

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUEST = os.path.join(REPO, "src", "engine", "guest.py")
PYTHON = os.environ.get("PYTHON", os.path.join(REPO, ".venv", "bin", "python3"))


class GuestProc:
    """The guest process + a file on its fd 3 (host side).

    We redirect the child's fd 3 to a temp file (deterministic, avoids
    descriptor renumbering) and poll-read it like the TS host does on its
    protocol pipe.
    """

    def __init__(self, helpers_dir=None, timeout_ms=None):
        self.fd3 = tempfile.NamedTemporaryFile(delete=False)
        self.fd3_name = self.fd3.name
        self.fd3.close()
        # Hermetic by default: a transient, empty helpers dir so the contract
        # suite never depends on (or writes into) the user's real helpers dir.
        self._owned_helpers = None
        if helpers_dir is None:
            self._owned_helpers = tempfile.mkdtemp(prefix="pi-repl-helpers-")
            helpers_dir = self._owned_helpers
        env = dict(os.environ, PI_REPL_NONCE="testnonce")
        env["PI_HELPERS_DIR"] = helpers_dir
        if timeout_ms:
            env["PI_REPL_TIMEOUT_MS"] = str(timeout_ms)
        # bash guarantees the child's fd 3 = the temp file
        self.proc = subprocess.Popen(
            ["bash", "-c", f"exec 3> {self.fd3_name}; exec {PYTHON} {GUEST}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self.pos = 0

    def frames(self, timeout=15):
        """Yield parsed JSON frames as they append to the fd3 file."""
        end = time.time() + timeout
        produced = []
        while time.time() < end:
            try:
                with open(self.fd3_name, "r") as f:
                    f.seek(self.pos)
                    data = f.read()
                    self.pos = f.tell()
            except OSError:
                data = ""
            for line in data.split("\n"):
                line = line.strip()
                if line:
                    produced.append(json.loads(line))
            for m in produced:
                yield m
            if produced:
                produced = []
            time.sleep(0.05)

    def send(self, msg):
        env = {"__repl": 1, **msg, "n": "testnonce"}
        self.proc.stdin.write((json.dumps(env) + "\n").encode())
        self.proc.stdin.flush()

    def recv_type(self, kind, cell_id=None, timeout=20):
        end = time.time() + timeout
        for m in self.frames(timeout):
            if m.get("type") == kind and (
                cell_id is None or m.get("cellId") == cell_id
            ):
                return m
            if time.time() > end:
                break
        raise AssertionError(f"no '{kind}' frame in time")

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass
        try:
            os.unlink(self.fd3_name)
        except OSError:
            pass
        if self._owned_helpers:
            import shutil

            shutil.rmtree(self._owned_helpers, ignore_errors=True)


def run_cell(g, code, cell_id="c1"):
    g.send({"type": "run", "cellId": cell_id, "code": code})
    # collect frames up to the done, returning (done, list_of_stream)
    end = time.time() + 20
    done = None
    streams = []
    for m in g.frames(timeout=20):
        if m.get("type") == "done" and m.get("cellId") == cell_id:
            done = m
            break
        if m.get("type") == "stream" and m.get("cellId") == cell_id:
            streams.append(m)
        if time.time() > end:
            raise AssertionError("no done in time")
    return done, streams


@pytest.fixture
def guest():
    g = GuestProc()
    try:
        # wait ready
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        yield g
    finally:
        g.close()


def _write(dirpath, name, body):
    import pathlib

    pathlib.Path(dirpath, name).write_text(body)


# Contract-equivalent seeded helpers. The shipping defaults live embedded in
# scripts/setup-venv.mjs and are written into the USER helpers dir on install;
# these are hermetic in-tests copies that pin the guest-side contract (fresh
# read, process-group teardown / stale-guard, no commit on error, diff).
SHELL_BLOCK = """\
import os as _os
import signal as _sig
import subprocess as _sp


class _Result:
    __slots__ = ("args", "returncode", "stdout", "stderr")

    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class shell:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __call__(self, command=None, *, cwd=None, env=None, input=None, timeout=None):
        with _sp.Popen(
            command, shell=True, stdin=_sp.PIPE, stdout=_sp.PIPE, stderr=_sp.PIPE,
            text=True, cwd=cwd, env=env, start_new_session=_os.name == "posix",
        ) as p:
            try:
                out, err = p.communicate(input=input, timeout=timeout)
            except _sp.TimeoutExpired:
                try:
                    _os.killpg(_os.getpgid(p.pid), _sig.SIGKILL)
                except Exception:
                    pass
                try:
                    p.communicate()
                except Exception:
                    pass
                raise
        return _Result(command, p.returncode, out, err)

    run = __call__
"""

EDIT_BLOCK = """
import difflib as _d
import pathlib as _p


class edit:
    def __init__(self, path, *, quiet=False):
        self.path = _p.Path(path)
        self.quiet = quiet
        self.text = ""
        self.diff = ""
        self.committed = False
        self._offset = ""
        self._sig = None

    def __enter__(self):
        if self.path.exists():
            self.text = self.path.read_text()
            st = self.path.stat()
            self._sig = (st.st_mtime_ns, st.st_size)
        else:
            self.text = ""
            self._sig = None
        self._offset = self.text
        return self

    def edit(self, old, new):
        n = self.text.count(old)
        if n == 0:
            raise ValueError("edit(): text not found in the file")
        if n > 1:
            positions, start = [], 0
            while True:
                idx = self.text.find(old, start)
                if idx == -1:
                    break
                positions.append(self.text.count("\\n", 0, idx) + 1)
                start = idx + 1
            lines = ", ".join(str(i) for i in positions)
            raise ValueError(f"edit(): found {n} occurrences (lines {lines}) — anchor not unique")
        self.text = self.text.replace(old, new, 1)

    def __exit__(self, exc_type, exc_value, tb):
        if exc_type is not None:
            return False
        if self.text == self._offset:
            return False
        if self._sig is not None:
            st = self.path.stat()
            if (st.st_mtime_ns, st.st_size) != self._sig:
                raise RuntimeError("edit: changed on disk since block opened")
        self.path.write_text(self.text)
        self.committed = True
        self.diff = "".join(
            _d.unified_diff(self._offset.splitlines(keepends=True),
                            self.text.splitlines(keepends=True))
        )
        if self.diff and not self.quiet:
            print(self.diff)
        return False
"""


@pytest.fixture
def guest_with_shell():  # a hermetic helpers dir seeded with a shell block
    d = tempfile.mkdtemp(prefix="pi-repl-shell-")
    _write(d, "shell.py", SHELL_BLOCK)
    g = GuestProc(helpers_dir=d)
    try:
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        yield g
    finally:
        g.close()
        import shutil

        shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def guest_with_edit():  # hermetic helper dir seeded with the shell + edit blocks
    d = tempfile.mkdtemp(prefix="pin-plug-in")
    _write(d, "shell.py", SHELL_BLOCK)
    _write(d, "edit.py", EDIT_BLOCK)
    g = GuestProc(helpers_dir=d)
    try:
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        yield g
    finally:
        g.close()
        import shutil

        shutil.rmtree(d, ignore_errors=True)


# --- persistence ---
def test_variables_survive_across_cells(guest):
    d, _ = run_cell(guest, "x = 10", "c1")
    assert d["status"] == "ok"
    d2, streams = run_cell(guest, "print('x is', x)", "c2")
    assert d2["status"] == "ok"
    assert any("x is 10" in m["chunk"] for m in streams)


def test_functions_defined_persist(guest):
    run_cell(guest, "def double(n):\n    return n * 2", "c1")
    d, streams = run_cell(guest, "print(double(21))", "c2")
    assert d["status"] == "ok"
    assert any("42" in m["chunk"] for m in streams)


# --- error survival ---
def test_error_does_not_kill_namespace(guest):
    run_cell(guest, "x = 7", "c1")
    d, _ = run_cell(guest, "1 / 0", "c2")
    assert d["status"] == "error"
    assert d["error"]["message"]
    # x still available — a subsequent assignment works (no fatal state loss)
    d4, _ = run_cell(guest, "y = x + 1", "c4")
    assert d4["status"] == "ok"
    d5, s5 = run_cell(guest, "print(y)", "c5")
    assert d5["status"] == "ok"
    assert any("8" in m["chunk"] for m in s5)


# --- output attribution ---
def test_only_printed_output_and_result_return(guest):
    d, streams = run_cell(guest, "z = 100", "c1")
    assert d["status"] == "ok"
    assert streams == []  # a plain assignment prints nothing
    d2, streams2 = run_cell(guest, "print('saw', z)", "c2")
    assert d2["status"] == "ok"
    assert any("saw 100" in m["chunk"] for m in streams2)


# --- snapshot / restore ---
def test_snapshot_and_restore(guest):
    run_cell(guest, "data = {'count': 42}", "c1")
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert "data" in snap["vars"], (
        f"expected data in snapshot, got {list(snap['vars'])}"
    )

    # simulate a fresh guest restored from the snapshot
    guest2 = GuestProc()
    for m in guest2.frames(timeout=20):
        if m.get("type") == "ready":
            break
    guest2.send({"type": "restore", "id": "r1", "vars": snap["vars"]})
    rres = guest2.recv_type("restore_result", timeout=10)
    assert "data" in rres["restored"]
    dd, sst = run_cell(guest2, "print(data['count'])", "c9")
    assert dd["status"] == "ok"
    assert any("42" in m["chunk"] for m in sst)
    guest2.close()


def test_snapshot_excludes_helper_metadata(guest):
    # helper python names (e.g. helper_description and helper vars) are exec'd
    # into the kernel but are NOT user state; they must never land in a snapshot.
    run_cell(guest, "data = {'count': 42}", "c1")
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert "data" in snap["vars"]
    assert "helper_description" not in snap["vars"]
    assert "shell" not in snap["vars"]


def test_snapshot_is_flagged_complete(guest):
    # A valid snapshot — even of an empty namespace — must be reported as
    # complete so the host can never; an empty snapshot would be marked
    # incomplete and the host would keep the last good file.
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert snap["complete"] is True


def test_high_output_is_capped_guest_side(guest):
    # A runaway print must not accumulate unbounded output in the guest or slip
    # a giant frame to the host. It completes, but the captured stdout stays
    # within the guest's buffer, not the full 10MB.
    d, streams = run_cell(guest, "print('x' * 10_000_000)", "c1")
    assert d["status"] == "ok"
    total = sum(len(m["chunk"]) for m in streams)
    assert total < 2_000_000, total


# --- list_names ---
def test_list_names(guest):
    run_cell(guest, "alpha = 1; beta = 2", "c1")
    guest.send({"type": "list_names", "id": "l1"})
    res = guest.recv_type("names_result", timeout=5)
    assert "alpha" in res["names"]
    assert "beta" in res["names"]


# --- helpers tests ---
def test_shell_helper_runs_commands(guest_with_shell):
    code = (
        "with shell() as s:\n    r = s.run('echo helper-ok')\nprint(r.stdout.strip())"
    )
    d, streams = run_cell(guest_with_shell, code, "c1")
    assert d["status"] == "ok"
    assert any("helper-ok" in m["chunk"] for m in streams)


def test_shell_helper_is_a_block_not_a_done_tool(guest_with_shell):
    # The helper owns only the shell plumbing; the caller writes the command, a
    # deliberate timeout, and what the structured output means.
    code = (
        "with shell() as s:\n"
        "    r = s.run('echo helper-value', timeout=30)\n"
        "print(r.stdout.strip(), r.returncode)"
    )
    d, streams = run_cell(guest_with_shell, code, "c1")
    assert d["status"] == "ok"
    joined = " ".join(m["chunk"] for m in streams)
    assert "helper-value 0" in joined


def test_help_and_ls_are_always_available(guest_with_shell):
    d, streams = run_cell(guest_with_shell, "print(ls())", "c1")
    assert d["status"] == "ok"
    joined = " ".join(m["chunk"] for m in streams)
    assert "shell" in joined
    # IPython bookkeeping must not leak into the tool list
    for noise in ("exit", "quit", "get_ipython", "open"):
        assert noise not in joined, f"ls() leaked {noise}: {joined}"
        d2, streams2 = run_cell(guest_with_shell, "print(help('shell'))", "c2")
    assert d2["status"] == "ok"
    joined2 = " ".join(m["chunk"] for m in streams2)
    assert "shell" in joined2


# --- edit block contract ---
def test_edit_applies_exactly_once_and_makes_no_backup(guest_with_edit):
    code = (
        "from pathlib import Path\n"
        "p = Path('target.txt')\n"
        "p.write_text('hello\\nworld\\n')\n"
        "with edit(p) as ed:\n"
        "    ed.edit('world', 'everyone')\n"
        "print(p.read_text().strip(), '|bak?', Path(str(p) + '.bak').exists())"
    )
    d, streams = run_cell(guest_with_edit, code, "c1")
    assert d["status"] == "ok", d
    joined = " ".join(m["chunk"] for m in streams)
    assert "everyone" in joined
    # atomic write + git cover recovery: no .bak is ever auto-created
    assert "bak? False" in joined


def test_edit_commits_and_prints_a_diff(guest_with_edit):
    code = (
        "from pathlib import Path\n"
        "p = Path('diffed.txt')\n"
        "p.write_text('line1\\nline2\\n')\n"
        "with edit(p) as ed:\n"
        "    ed.edit('line2', 'CHANGED')\n"
    )
    d, streams = run_cell(guest_with_edit, code, "c1")
    assert d["status"] == "ok", d
    joined = " ".join(m["chunk"] for m in streams)
    assert "CHANGED" in joined  # the diff surfaced the new content


def test_edit_guard_rejects_an_ambiguous_or_missing_anchor(guest_with_edit):
    # ed.edit must never silently edit the wrong one of many, nor apply a stale
    # anchor that is no longer in the file — it raises and leaves the file alone.
    code = (
        "from pathlib import Path\n"
        "p = Path('guard.txt')\n"
        "p.write_text('x\\ny\\nx\\n')\n"
        "try:\n"
        "    with edit(p) as ed:\n"
        "        ed.edit('x', 'X')\n"
        "        raise ValueError('no')\n"
        "except ValueError as e:\n"
        "    print('AMBIG', str(e))\n"
        "print('file1', repr(p.read_text()))\n"
        "try:\n"
        "    with edit(p) as ed:\n"
        "        ed.edit('zz', 'Z')\n"
        "except ValueError:\n"
        "    print('NOTFOUND', 'true')\n"
        "print('file2', repr(p.read_text()))"
    )
    d, streams = run_cell(guest_with_edit, code, "c1")
    assert d["status"] == "ok", d
    joined = " ".join(m["chunk"] for m in streams)
    assert "AMBIG edit(): found 2 occurrences (lines 1, 3)" in joined  # 1-indexed
    assert "not unique" in joined
    assert "file1 'x\\ny\\nx\\n'" in joined
    assert "NOTFOUND true" in joined
    assert "file2 'x\\ny\\nx\\n'" in joined  # untouched after both failures


def test_edit_aborts_without_writing_on_exception(guest_with_edit):
    # An exception inside the block must propagate AND leave the file untouched
    # (no commit, no temp residue).
    code = (
        "from pathlib import Path\n"
        "p = Path('abort.txt')\n"
        "p.write_text('original')\n"
        "try:\n"
        "    with edit(p) as ed:\n"
        "        ed.edit('original', 'should-not-write')\n"
        "        raise ValueError('stop')\n"
        "except Exception:\n"
        "    pass\n"
        "print(p.read_text())"
    )
    d, streams = run_cell(guest_with_edit, code, "c1")
    assert d["status"] == "ok", d
    joined = " ".join(m["chunk"] for m in streams)
    assert "original" in joined


def test_edit_refuses_to_clobber_a_stale_file(guest_with_edit):
    # If the file changes on disk after the block opened, commit must refuse
    # instead of overwriting the newer content.
    code = (
        "from pathlib import Path\n"
        "p = Path('stale.txt')\n"
        "p.write_text('alpha')\n"
        "with edit(p) as ed:\n"
        "    ed.text = ed.text.replace('alpha', 'beta')\n"
        "    p.write_text('gamma-on-disk')  # touched while the block is open\n"
    )
    d, streams = run_cell(guest_with_edit, code, "c1")
    assert d["status"] == "error", d  # the stale guard raises inside __exit__
    d3, s3 = run_cell(guest_with_edit, "print(open('stale.txt').read())", "c3")
    assert any("gamma-on-disk" in m["chunk"] for m in s3)  # newer content survived


def test_helpers_dir_is_the_only_source():
    # A custom helpers dir provides EXACTLY what's loaded: nothing else is
    # seeded in beyond the shipped shell/edit blocks (the old read/write/bash
    # helpers are gone for good).
    import pathlib, shutil

    d = tempfile.mkdtemp()
    try:
        (pathlib.Path(d) / "double.py").write_text("def double(n):\n    return n * 2\n")
        g = GuestProc(helpers_dir=d)
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        try:
            d2, streams = run_cell(g, "print(double(21))", "c1")
            assert d2["status"] == "ok"
            assert any("42" in m["chunk"] for m in streams)
            _, s3 = run_cell(g, "print(ls())", "c2")
            joined = " ".join(m["chunk"] for m in s3)
            assert "double" in joined
            for stale in ("read", "write", "bash"):
                assert stale not in joined, f"unexpected stale helper: {stale}"
            # shell/edit are shipped, but only if the dir actually seeds them
            assert "shell" not in joined and "edit" not in joined
        finally:
            g.close()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_restore_reports_failed_values_without_crashing(guest):
    # Restoring garbage must be reported in `failed`, never crash the evaluator.
    # "good" is a real pickle of 42; "junk" is not valid pickle.
    guest.send(
        {
            "type": "restore",
            "id": "r1",
            "vars": {
                "good": "gAVLKi4=",
                "junk": "not-valid-pickle-base64!!!",
            },
        }
    )
    res = guest.recv_type("restore_result", timeout=10)
    assert "good" in res["restored"]
    assert any(f["name"] == "junk" for f in res["failed"])
    # the guest is still responsive afterwards
    d, _ = run_cell(guest, "print('still alive')", "c2")
    assert d["status"] == "ok"


def test_cell_timeout_is_reported_as_error(guest):
    # A cell that exceeds the per-cell timeout must NOT be reported as "ok".
    # Use a tiny timeout so the fixed 0.5s sleep that follows exceeds it.
    g = GuestProc(timeout_ms=400)
    try:
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        d, _ = run_cell(g, "import time; time.sleep(0.5); print('late')", "c1")
        assert d["status"] == "error", d
        assert "did not finish" in d["error"]["message"].lower()
    finally:
        g.close()


def test_silence_watchdog_allows_active_work(guest):
    # The timeout is a SILENCE watchdog, not a wall-clock cap: a cell that keeps
    # producing output past the threshold must still complete. Use a good margin
    # between the beat cadence and the watchdog so scheduling jitter can't trip it.
    g = GuestProc(timeout_ms=800)
    try:
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        d, streams = run_cell(
            g,
            "import time\nfor _ in range(20):\n    print('beat')\n    time.sleep(0.05)\nprint('done')",
            "c1",
        )
        assert d["status"] == "ok", d
        assert any("done" in m["chunk"] for m in streams)
    finally:
        g.close()
