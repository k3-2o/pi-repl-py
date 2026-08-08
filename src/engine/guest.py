"""
guest.py — the real IPython kernel guest evaluator for pi-repl.

The TypeScript host (EngineManager) spawns this process once. It starts a real
local ipykernel via jupyter_client (a subprocess IPython kernel, no separate
Jupyter server), keeps it alive for the whole session, and bridges the pi-rlm
wire protocol to it:

  stdin (fd 0)  = typed HostToGuest JSON lines   {"run","ping","snapshot",...}
  fd 3          = GuestToHost JSON lines         {"ready","stream","done",...}

State (variables, functions, imports) survives across calls because the same
kernel subprocess lives for the whole process. Consecutive cells run against
the same IPython namespace.

The protocol envelope carries a nonce (PI_RLM_NONCE) the host mints and this
process erases from its environment before any cell runs, so agent code cannot
forge protocol traffic on fd 3. Errors surface as "done" status "error" with the
traceback; the kernel stays alive for the next cell.
"""

from __future__ import annotations

import json
import os
import sys

# ── protocol envelope ────────────────────────────────────────────────────────
ENVELOPE_KEY = "__rlm"
NONCE_ENV = "PI_RLM_NONCE"
PROTOCOL_FD = 3

NONCE = os.environ.get(NONCE_ENV, "")
os.environ.pop(NONCE_ENV, None)

# Per-cell timeout, from the host engine config (default 60s).
CELL_TIMEOUT_S = float(os.environ.get("PI_REPL_TIMEOUT_MS", "60000")) / 1000.0

# ── fd 3 protocol writer (line-buffered) ─────────────────────────────────────
# dup so we don't close the caller's fd 3 on process exit; line-buffered for
# atomic JSON frames.
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


# ── toolbox functions, exec'd into every kernel ─────────────────────────────
# Loaded from a directory (default: the sibling `tools/` dir shipped with the
# repo; overridable via PI_TOOLBOX_DIR for the user's own folder). Each *.py file
# defines one exported function. `help` and `ls` are hard-wired here, not
# configurable, so a weak model always has a way to discover the toolbox.

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
def ls():
    return sorted([n for n in globals() if not n.startswith('__') and callable(globals()[n])])

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

    def execute(self, code):
        """Run `code`; return (stdout, stderr, error_text, result)."""
        msg_id = self.kc.execute(code)
        out, err, error, result = [], [], None, None
        while True:
            try:
                m = self.kc.get_iopub_msg(timeout=CELL_TIMEOUT_S)
            except Exception:
                break
            if m.get("parent_header", {}).get("msg_id") != msg_id:
                continue
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
        return "".join(out), "".join(err), error, result

    def snapshot_globals(self):
        # Skip the toolbox functions and intrinsic helpers (functions don't
        # pickle anyway; excluding avoids a noisy `failed` list on every save).
        tool_names = sorted(set(_TOOLBOX_SRC) | {"ls", "help"})
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
            return {}, []
        try:
            o = json.loads(out.split(marker)[-1])
            return o.get("vars", {}), o.get("failed", [])
        except Exception:
            return {}, []

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
            vars_, failed = kernel.snapshot_globals()
            _send({"type": "snapshot_result", "id": msg["id"], "vars": vars_, "failed": failed})
        elif t == "restore":
            restored, failed = kernel.restore_globals(msg.get("vars", {}))
            _send({"type": "restore_result", "id": msg["id"], "restored": restored, "failed": failed})
        elif t == "list_names":
            names = list(kernel.snapshot_globals()[0].keys())
            _send({"type": "names_result", "id": msg["id"], "names": names})
        elif t == "run":
            cell_id = msg.get("cellId")
            stdout, stderr, error, result = kernel.execute(msg.get("code", ""))
            if stdout:
                _send({"type": "stream", "cellId": cell_id, "name": "stdout", "chunk": stdout})
            if stderr:
                _send({"type": "stream", "cellId": cell_id, "name": "stderr", "chunk": stderr})
            if error:
                _send({"type": "done", "cellId": cell_id, "status": "error", "error": _line_error(error)})
            else:
                _send({"type": "done", "cellId": cell_id, "status": "ok", "result": result})
        # "abort" is cooperative-only; the host hard-kills us for a real timeout.


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _send({"type": "done", "cellId": "", "status": "error", "error": _line_error(str(e))})
        sys.exit(1)