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

    def __init__(self, toolbox_dir=None, timeout_ms=None):
        self.fd3 = tempfile.NamedTemporaryFile(delete=False)
        self.fd3_name = self.fd3.name
        self.fd3.close()
        env = dict(os.environ, PI_RLM_NONCE="testnonce")
        if toolbox_dir:
            env["PI_TOOLBOX_DIR"] = toolbox_dir
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
        env = {"__rlm": 1, **msg, "n": "testnonce"}
        self.proc.stdin.write((json.dumps(env) + "\n").encode())
        self.proc.stdin.flush()

    def recv_type(self, kind, cell_id=None, timeout=20):
        end = time.time() + timeout
        for m in self.frames(timeout):
            if m.get("type") == kind and (cell_id is None or m.get("cellId") == cell_id):
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


# ── persistence ────────────────────────────────────────────────────────────
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


# ── error survival ─────────────────────────────────────────────────────────────
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


# ── output attribution ─────────────────────────────────────────────────────────
def test_only_printed_output_and_result_return(guest):
    d, streams = run_cell(guest, "z = 100", "c1")
    assert d["status"] == "ok"
    assert streams == []  # a plain assignment prints nothing
    d2, streams2 = run_cell(guest, "print('saw', z)", "c2")
    assert d2["status"] == "ok"
    assert any("saw 100" in m["chunk"] for m in streams2)


# ── snapshot / restore ─────────────────────────────────────────────────────────
def test_snapshot_and_restore(guest):
    run_cell(guest, "data = {'count': 42}", "c1")
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert "data" in snap["vars"], f"expected data in snapshot, got {list(snap['vars'])}"

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


def test_snapshot_excludes_toolbox_metadata(guest):
    # function_description (and other toolbox metadata) is exec'd into the kernel
    # namespace but is NOT user state; it must not appear in a snapshot.
    run_cell(guest, "data = {'count': 42}", "c1")
    guest.send({"type": "snapshot", "id": "s1"})
    snap = guest.recv_type("snapshot_result", timeout=20)
    assert "data" in snap["vars"]
    assert "function_description" not in snap["vars"]
    assert "read" not in snap["vars"]


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


# ── list_names ─────────────────────────────────────────────────────────────────
def test_list_names(guest):
    run_cell(guest, "alpha = 1; beta = 2", "c1")
    guest.send({"type": "list_names", "id": "l1"})
    res = guest.recv_type("names_result", timeout=5)
    assert "alpha" in res["names"]
    assert "beta" in res["names"]


# ── toolbox: read / write / edit / bash + intrinsic help/ls ─────────────────
def test_bash_helper_runs_commands(guest):
    d, streams = run_cell(guest, "r = bash('echo toolbox-ok'); print(r.stdout.strip())", "c1")
    assert d["status"] == "ok"
    assert any("toolbox-ok" in m["chunk"] for m in streams)


def test_read_helper(guest):
    import os
    path = os.path.join(tempfile.mkdtemp(), "r.txt")
    with open(path, "w") as f:
        f.write("line1\nline2\nline3\n")
    d, streams = run_cell(guest, f"print(read({path!r}).splitlines()[0])", "c1")
    assert d["status"] == "ok"
    assert any("line1" in m["chunk"] for m in streams)


def test_write_helper(guest):
    import os
    p = os.path.join(tempfile.mkdtemp(), "w.txt")
    d, _ = run_cell(guest, f"print(write({p!r}, 'hello world'))", "c1")
    assert d["status"] == "ok"
    with open(p) as f:
        assert f.read() == "hello world"


def test_edit_rejects_stale_anchor(guest):
    import os
    p = os.path.join(tempfile.mkdtemp(), "e.txt")
    with open(p, "w") as f:
        f.write("the quick brown fox")
    # exact, single occurrence
    d, _ = run_cell(guest, f"print(edit({p!r}, 'quick', 'slow'))", "c1")
    assert d["status"] == "ok"
    with open(p) as f:
        assert "slow brown fox" in f.read()
    # stale anchor (already gone) fails loudly, no silent mangle
    d2, _ = run_cell(guest, f"edit({p!r}, 'quick', 'again')", "c2")
    assert d2["status"] == "error"
    assert "could not find" in d2["error"]["message"]
    assert "quick" not in open(p).read()


def test_help_and_ls_are_always_available(guest):
    d, streams = run_cell(guest, "print(ls())", "c1")
    assert d["status"] == "ok"
    joined = " ".join(m["chunk"] for m in streams)
    assert "read" in joined and "bash" in joined
    # IPython bookkeeping must not leak into the tool list
    for noise in ("exit", "quit", "get_ipython", "open"):
        assert noise not in joined, f"ls() leaked {noise}: {joined}"
    d2, streams2 = run_cell(guest, "print(help('edit'))", "c2")
    assert d2["status"] == "ok"
    assert any("edit" in m["chunk"] for m in streams2)

def test_restore_reports_failed_values_without_crashing(guest):
    # Restoring garbage must be reported in `failed`, never crash the evaluator.
    # "good" is a real pickle of 42; "junk" is not valid pickle.
    guest.send({
        "type": "restore", "id": "r1",
        "vars": {
            "good": "gAVLKi4=",
            "junk": "not-valid-pickle-base64!!!",
        },
    })
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


def test_custom_tool_file_loads_from_toolbox_dir():
    # A user folder in PI_TOOLBOX_DIR is loaded into the kernel; a one-file custom
    # function appears alongside. Setting PI_TOOLBOX_DIR replaces the shipped
    # default set rather than merging, so only the custom function is present.
    import pathlib
    import shutil
    d = tempfile.mkdtemp()
    try:
        (pathlib.Path(d) / "double.py").write_text("def double(n):\n    return n * 2\n")
        g = GuestProc(toolbox_dir=d)
        for m in g.frames(timeout=20):
            if m.get("type") == "ready":
                break
        try:
            d2, streams = run_cell(g, "print(double(21))", "c1")
            assert d2["status"] == "ok"
            assert any("42" in m["chunk"] for m in streams)
        finally:
            g.close()
    finally:
        shutil.rmtree(d, ignore_errors=True)
