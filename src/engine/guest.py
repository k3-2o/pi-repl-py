"""
guest.py — the real IPython kernel guest evaluator for pi-repl.

The host spawns this once. It starts a local ipykernel subprocess via
jupyter_client, keeps it for the session, and bridges the wire protocol to it
(stdin = commands, fd 3 = results). State survives because the kernel process
does. Frames carry a nonce the host mints and the guest erases, so agent code
cannot forge protocol traffic.
"""

from __future__ import annotations

import json
import os
import sys
import time

# ── protocol envelope ────────────────────────────────────────────────────────
ENVELOPE_KEY = "__rlm"
NONCE_ENV = "PI_RLM_NONCE"
PROTOCOL_FD = 3

NONCE = os.environ.get(NONCE_ENV, "")
os.environ.pop(NONCE_ENV, None)

# Per-cell timeout comes from the host config (default "0" = no wall-clock cap).
# When nonzero it is a SILENCE watchdog: it trips only if the cell emits no
# output for that many seconds, never after N elapsed. A signal that is slow but
# producing output (or a deliberately silent `find | sort`) can run to completion.
CELL_TIMEOUT_S = float(os.environ.get("PI_REPL_TIMEOUT_MS", "0") or "0") / 1000.0

# Snapshot/restore are internal bookkeeping, not user work: a huge namespace can
# legitimately take longer than a cell, so they get a separate (fixed) window
# instead of being throttled by a silence timer and silently losing state.
SNAPSHOT_TIMEOUT_S = 90.0

# fd 3 protocol writer; dup'd so we don't close the caller's fd 3 on exit.
_proto = os.fdopen(os.dup(PROTOCOL_FD), "w", buffering=1)


def _send(msg):
    envelope = {ENVELOPE_KEY: 1, **msg}
    if NONCE:
        envelope["n"] = NONCE
    _proto.write(json.dumps(envelope) + "\n")
    _proto.flush()


def _decode(line):
    if ENVELOPE_KEY not in line:
        return None
    try:
        obj = json.loads(line)
    except Exception:
        return None
    if obj.get(ENVELOPE_KEY) != 1 or not isinstance(obj.get("type"), str):
        return None
    if NONCE and obj.get("n") != NONCE:
        return None
    return obj


# Toolbox: one function per *.py, exec'd into every kernel (`PI_TOOLBOX_DIR`,
# default the sibling toolbox/ dir). help/ls are hard-wired, not configurable.

def _toolbox_files(directory):
    """Return {function_name: source} for each *.py in `directory`."""
    if not directory:
        return {}
    d = os.path.expanduser(directory)
    if not os.path.isdir(d):
        return {}
    names = {}
    for entry in sorted(os.listdir(d)):
        if not entry.endswith(".py"):
            continue
        name = entry[:-3]
        if not name.isidentifier() or name.startswith("_"):
            continue
        try:
            with open(os.path.join(d, entry), encoding="utf-8") as f:
                names[name] = f.read()
        except OSError:
            continue
    return names

DEFAULT_TOOLBOX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toolbox")
TOOLBOX_DIR = os.environ.get("PI_TOOLBOX_DIR", "").strip()
_TOOLBOX_SRC = _toolbox_files(TOOLBOX_DIR or DEFAULT_TOOLBOX_DIR)

# help/ls are part of the evaluator, not the toolbox: any kernel, even a bare
# one, gets a way to discover what is loaded.
INTRINSIC = """
# IPython injects a few globals (exit/quit/get_ipython/open/...) that aren't the
# agent's toolbox; ls() must not surface them as callable tooling.
_RPL_LS_NOISE = {'exit', 'quit', 'get_ipython', 'open', 'display'}

def ls():
    return sorted(n for n in globals() if n not in _RPL_LS_NOISE and not n.startswith('_') and callable(globals()[n]))

def help(name=None):
    if name is None:
        return ls()
    fn = globals().get(name)
    if fn is None or not callable(fn):
        return f"no such function: {name!r}"
    return fn.__doc__ or f"{name} (no docstring)"
"""


from jupyter_client import KernelManager


class Kernel:
    """A persistent subprocess ipykernel + blocking client."""

    def __init__(self):
        self.km = KernelManager(kernel_name="python3")
        self.km.start_kernel()
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=30)
        self._preload()

    def _preload(self):
        """Exec every toolbox function + the intrinsic help/ls into the kernel ns."""
        code = INTRINSIC + "\n"
        for src in _TOOLBOX_SRC.values():
            code += src + "\n"
        if code.strip():
            self.kc.execute(code)
            self._drain()

    def _drain(self):
        try:
            while True:
                m = self.kc.get_iopub_msg(timeout=1)
                if m.get("msg_type") == "status" and m.get("content", {}).get("execution_state") == "idle":
                    break
        except Exception:
            pass

    def _drain_execution(self, code, timeout):
        """Run `code`; return (stdout, stderr, error_text, result, timed_out).

        `timeout <= 0` means "no cap": a cell runs until it reports idle.
        `timeout > 0` is a SILENCE watchdog — it trips only once the cell has
        produced no message for `timeout` seconds. A silent-but-running command
        (e.g. `find ... | sort`) is allowed to complete; a stalled one (dead
        kernel, or nothing for the silence window) reports `timed_out=True` so
        the caller can surface a real hang instead of faking success.
        """
        msg_id = self.kc.execute(code)
        out, err, error, result = [], [], None, None
        timed_out = False
        # Silence clock: only starts once the cell has actually begun (first
        # iopub message for it). This gives a slow-spawned kernel a grace period
        # so the first-scheduled cell isn't falsely tripped.
        last_activity: float | None = None
        while True:
            if not self.km.is_alive():
                timed_out = True
                break
            if last_activity is not None and timeout and (time.monotonic() - last_activity) >= timeout:
                timed_out = True
                break
            wait = (timeout - (time.monotonic() - last_activity)) if (last_activity is not None and timeout) else 0.25
            try:
                m = self.kc.get_iopub_msg(timeout=max(0.01, min(0.25, wait)))
            except Exception:
                continue
            if m.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            if last_activity is None:
                last_activity = time.monotonic()
            else:
                last_activity = time.monotonic()
            mt = m.get("msg_type")
            c = m.get("content", {})
            if mt == "stream":
                (out if c.get("name") == "stdout" else err).append(c.get("text", ""))
            elif mt == "execute_result":
                result = c.get("data", {}).get("text/plain")
            elif mt == "error":
                error = "\n".join(c.get("traceback", ["(no traceback)"]))
            elif mt == "status" and c.get("execution_state") == "idle":
                break
        if timed_out:
            # Best-effort: cancel the stuck code so the NEXT cell does not queue
            # behind it. Interrupt delivers SIGINT to the kernel; for a real hang
            # the parent host kills the process and we report the wedge above.
            try:
                self.kc.interrupt_kernel()
            except Exception:
                pass
        return "".join(out), "".join(err), error, result, timed_out

    def execute(self, code):
        """Idle-sync path used by snapshot/restore; not a user cell."""
        return self._drain_execution(code, SNAPSHOT_TIMEOUT_S)[:4]

    def run_cell(self, code):
        """Run a user cell under the per-cell timeout, so the model learns
        when work did not finish."""
        return self._drain_execution(code, CELL_TIMEOUT_S)

    def snapshot_globals(self):
        # Skip the toolbox functions and intrinsic helpers (functions don't
        # pickle anyway; excluding avoids a noisy `failed` list on every save).
        # Skip the toolbox/intrinsic functions, plus the toolbox metadata globals
        # (function_description) which are exec'd into the namespace but are not
        # user state and must not be snapshotted as such.
        tool_names = sorted(set(_TOOLBOX_SRC) | {"ls", "help", "function_description"})
        skip_names = json.dumps(tool_names)
        out, _, _, _ = self.execute(
            "import pickle as _pk, base64 as _b64, json as _js\n"
            "__rlm_skip = set(" + skip_names + ") | {'In','Out','get_ipython','exit','quit','open'}\n"
            "__rlm_v = {}\n__rlm_f = []\n"
            "for _k, _v in list(globals().items()):\n"
            "    # skip IPython bookkeeping and names with a leading underscore\n"
            "    if _k.startswith('__') or _k.startswith('_') or _k in __rlm_skip:\n"
            "        continue\n"
            "    try:\n"
            "        __rlm_v[_k] = _b64.b64encode(_pk.dumps(_v)).decode()\n"
            "    except Exception as _e:\n"
            "        __rlm_f.append({'name': _k, 'reason': str(_e)})\n"
            "print('__RLC_SNAPSHOT__' + _js.dumps({'vars': __rlm_v, 'failed': __rlm_f}))\n"
        )
        marker = "__RLC_SNAPSHOT__"
        if marker not in out:
            # The print at the cell's end never happened: the kernel stalled or
            # the serialization was interrupted, so this is NOT a valid snapshot.
            # Return incomplete so the host keeps the last good snapshot file.
            return {}, [], False
        try:
            o = json.loads(out.split(marker)[-1])
            return o.get("vars", {}), o.get("failed", []), True
        except Exception:
            return {}, [], False

    def restore_globals(self, vars_):
        if not vars_:
            return [], []
        # Unpickle each value in a single kernel cell for atomicity, wrapping
        # per-name so one failure reports itself and the rest still load.
        code2 = (
            "import pickle as _pk, base64 as _b64, json as _js\n"
            "__rl_r = {'restored': [], 'failed': []}\n"
            + "\n".join(
                "try:\n"
                f"    globals()[{name!r}] = _pk.loads(_b64.b64decode({b64!r}))\n"
                f"    __rl_r['restored'].append({name!r})\n"
                "except Exception as _e:\n"
                f"    __rl_r['failed'].append({{'name': {name!r}, 'reason': str(_e)}})\n"
                for name, b64 in vars_.items()
            )
            + "\nprint('__RLC_RESTORE__' + _js.dumps(__rl_r))"
        )
        out, _, _, _ = self.execute(code2)
        marker = "__RLC_RESTORE__"
        if marker not in out:
            return [], []
        try:
            obj = json.loads(out.split(marker)[-1])
            return obj.get("restored", []), obj.get("failed", [])
        except Exception:
            return [], []


def _line_error(text):
    lines = text.split("\n")
    return {"name": "", "message": text, "stack": lines[:12]}


def main():
    kernel = Kernel()
    _send({"type": "ready"})

    for line in sys.stdin:
        msg = _decode(line)
        if not msg:
            continue
        t = msg["type"]
        if t == "ping":
            _send({"type": "pong", "id": msg["id"]})
        elif t == "snapshot":
            vars_, failed, complete = kernel.snapshot_globals()
            _send({"type": "snapshot_result", "id": msg["id"], "vars": vars_, "failed": failed, "complete": complete})
        elif t == "restore":
            restored, failed = kernel.restore_globals(msg.get("vars", {}))
            _send({"type": "restore_result", "id": msg["id"], "restored": restored, "failed": failed})
        elif t == "list_names":
            names = list(kernel.snapshot_globals()[0].keys())
            _send({"type": "names_result", "id": msg["id"], "names": names})
        elif t == "run":
            cell_id = msg.get("cellId")
            stdout, stderr, error, result, timed_out = kernel.run_cell(msg.get("code", ""))
            if stdout:
                _send({"type": "stream", "cellId": cell_id, "name": "stdout", "chunk": stdout})
            if stderr:
                _send({"type": "stream", "cellId": cell_id, "name": "stderr", "chunk": stderr})
            if timed_out:
                tmsg = {
                    "name": "Timeout",
                    "message": f"cell did not finish within {CELL_TIMEOUT_S:g}s and may still be running",
                    "stack": ["[cell timed out]"],
                }
                _send({"type": "done", "cellId": cell_id, "status": "error", "error": tmsg})
            elif error:
                _send({"type": "done", "cellId": cell_id, "status": "error", "error": _line_error(error)})
            else:
                _send({"type": "done", "cellId": cell_id, "status": "ok", "result": result})
        # Note: the guest's main loop is single-threaded, so it stays inside
        # run_cell while a cell executes and cannot read an "abort" line until
        # the cell finishes. Cancel recovery therefore happens HOST-side: on an
        # aborted cell the engine is discarded and rebuilt so the next run
        # never queues behind a still-busy kernel.


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _send({"type": "done", "cellId": "", "status": "error", "error": _line_error(str(e))})
        sys.exit(1)