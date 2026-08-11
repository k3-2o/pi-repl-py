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
import shutil
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
            shutil.rmtree(self._owned_helpers, ignore_errors=True)


def run_cell(g, code, cell_id="c1"):
    g.send({"type": "run", "cellId": cell_id, "code": code})
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
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        yield g
    finally:
        g.close()


def _write(dirpath, name, body):
    import pathlib

    pathlib.Path(dirpath, name).write_text(body)


@pytest.fixture
def guest_with_custom_helper():  # hermetic helpers dir; the REPL seeds nothing
    d = tempfile.mkdtemp(prefix="pi-repl-helper-")
    _write(d, "double.py", "def double(n):\n    return n * 2\n")
    g = GuestProc(helpers_dir=d)
    try:
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        yield g
    finally:
        g.close()
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


# --- intristics: ls()/help() ---
def test_help_and_ls_are_always_available(guest):
    d, streams = run_cell(guest, "print(ls())", "c1")
    assert d["status"] == "ok"
    joined = " ".join(m["chunk"] for m in streams)
    # IPython bookkeeping must not leak into the tool/symbol list
    for noise in ("exit", "quit", "get_ipython", "open"):
        assert noise not in joined, f"ls() leaked {noise}: {joined}"
    d2, streams2 = run_cell(guest, "print(help('ls'))", "c2")
    assert d2["status"] == "ok"


def test_shell_and_edit_are_not_preloaded(guest):
    # A fresh install has NO preloaded shell/edit helpers — shell and file IO
    # are ordinary Python in the REPL. ls() must not advertise them.
    d, streams = run_cell(guest, "print(ls())", "c1")
    assert d["status"] == "ok"
    joined = " ".join(m["chunk"] for m in streams)
    for gone in ("shell", "edit"):
        assert gone not in joined, f"evicted helper still advertised: {gone}"


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
    run_cell(guest, "data = {'count': 42}", "c1")
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert "data" in snap["vars"]
    assert "helper_description" not in snap["vars"]


def test_snapshot_is_flagged_complete(guest):
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert snap["complete"] is True


def test_high_output_is_capped_guest_side(guest):
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


# --- helpers dir loading ---
def test_custom_helper_loading_and_no_stale_defaults(guest_with_custom_helper):
    # A user .py in the helpers dir loads into the kernel and appears in ls().
    d2, streams = run_cell(guest_with_custom_helper, "print(double(21))", "c1")
    assert d2["status"] == "ok"
    assert any("42" in m["chunk"] for m in streams)
    _, s3 = run_cell(guest_with_custom_helper, "print(ls())", "c2")
    joined = " ".join(m["chunk"] for m in s3)
    assert "double" in joined
    for stale in ("shell", "edit", "read", "write", "bash"):
        assert stale not in joined, f"unexpected stale helper: {stale}"


def test_restore_reports_failed_values_without_crashing(guest):
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
    d, _ = run_cell(guest, "print('still alive')", "c2")
    assert d["status"] == "ok"


def test_cell_timeout_is_reported_as_error(guest):
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