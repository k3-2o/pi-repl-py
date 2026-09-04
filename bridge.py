#!/usr/bin/env python3
"""pi-repl bridge: owns ipykernel and the Jupyter protocol; talks to the TS host over one stdio pipe.

Protocol (JSON lines; host -> bridge on stdin, bridge -> host on stdout):
  in:  {"op":"boot","helpers":[{"name":str,"source":str}]}             first message, before anything
       {"op":"exec","id":str,"code":str}                               run a cell (streams + one result)
       {"op":"snapshot","id":str,"path":str,"max_bytes":int}           snapshot the namespace to path
       {"op":"restore","id":str,"path":str}                            revive path into the namespace
       {"op":"listNames","id":str}                                     current public names
       {"op":"interrupt"}                                              KeyboardInterrupt in the kernel
       {"op":"shutdown","id":str}                                      graceful teardown, then exit 0
  out: {"type":"ready","helpers":[{"name":str,"ok":bool,"error":str?}]}      kernel up, helpers loaded
       {"type":"stream","id":str,"name":"stdout"|"stderr","text":str}        cell output, streamed
       {"type":"result","id":str,"status":"ok"|"error"|"aborted",            cell settled
              "result":str?,"error":{"name":str,"message":str,"stack":[str]}?}
       {"type":"reply","id":str,"..."}                                       snapshot/restore/names/shutdown
       {"type":"error","id":str?,"message":str}                              protocol-level failure
       {"type":"dying","message":str?}                                       best-effort before exit(1)

The bridge is single-threaded over the kernel (one op at a time); the host serializes ops anyway.
A stdin reader thread only relays lines; all kernel I/O stays on the main thread. When the kernel
dies (os._exit, SIGKILL, crash) the bridge exits: the host treats bridge exit as kernel death and
rebuilds from the last snapshot. stdin EOF (host gone) shuts the kernel down cleanly.
"""
import json
import os
import queue
import sys
import threading
import time

from jupyter_client import KernelManager
from jupyter_client.kernelspec import NoSuchKernel

SNAPSHOT_MIME = "application/vnd.pi-repl.snapshot+json"
RESTORE_MIME = "application/vnd.pi-repl.restore+json"
NAMES_MIME = "application/vnd.pi-repl.names+json"
READY_TIMEOUT_MS = 30_000

# --- kernel-side programs. These run inside ipykernel, so they stay strings (now plain Python). ---

SNAPSHOT_HEAD = """import pickle as _pk, base64 as _b64, json as _js, zlib as _zl, inspect as _in, linecache as _lc
def _repl_class_source(_c):
    _m = getattr(_c, '__init__', None)
    if _m is None or not _in.isfunction(_m):
        for _v in vars(_c).values():
            if _in.isfunction(_v):
                _m = _v
                break
    if _m is None:
        raise ValueError('class has no member methods')
    _start = _m.__code__.co_firstlineno
    _all = _lc.getlines(_m.__code__.co_filename)
    if not _all:
        raise ValueError('source not in linecache')
    _ln = _start - 1
    while _ln > 0:
        _prev = _all[_ln - 1].lstrip()
        if _prev.startswith('class ') and _c.__name__ in _prev:
            break
        _ln -= 1
    if _ln == 0:
        raise ValueError('class header not found')
    _head = _ln - 1
    while _head > 0:
        _p = _all[_head - 1].lstrip()
        if _p == '' or _p.startswith('@'):
            _head -= 1
        else:
            break
    _indent = len(_all[_head]) - len(_all[_head].lstrip())
    _block = [_all[_head]]
    _j = _head + 1
    while _j < len(_all):
        _line = _all[_j]
        if _line.strip() == '':
            _block.append(_line)
            _j += 1
            continue
        if len(_line) - len(_line.lstrip()) > _indent:
            _block.append(_line)
            _j += 1
        else:
            break
    return ''.join(_block)
"""


def skip_set_literal(helper_names):
    skip = list(helper_names) + ["helper_description", "In", "Out", "get_ipython", "exit", "quit", "open"]
    return json.dumps(skip)


def snapshot_code(helper_names, max_bytes):
    return (SNAPSHOT_HEAD
            + "__repl_skip = set(" + skip_set_literal(helper_names) + ")\n"
            + "__repl_max = " + str(max_bytes) + "\n"
            + """__repl_e = []
__repl_f = []
__repl_total = 0
for _k, _v in list(globals().items()):
    if _k.startswith('_') or _k in __repl_skip:
        continue
    __repl_p = None
    __repl_kind = 'value'
    try:
        if _in.isfunction(_v):
            __repl_src = _in.getsource(_v)
            if __repl_src:
                __repl_p = _b64.b64encode(__repl_src.encode()).decode()
                __repl_kind = 'def'
        elif _in.isclass(_v):
            __repl_src = _repl_class_source(_v)
            if __repl_src:
                __repl_p = _b64.b64encode(__repl_src.encode()).decode()
                __repl_kind = 'def'
    except Exception:
        __repl_p = None
        __repl_kind = 'value'
    try:
        if __repl_p is None:
            __repl_p = _b64.b64encode(_zl.compress(_pk.dumps(_v), 1)).decode()
        __repl_b = len(__repl_p)
        if __repl_b > __repl_max:
            __repl_f.append({'name': _k, 'reason': 'exceeds per-entry snapshot cap'})
        elif __repl_total + __repl_b > __repl_max:
            __repl_f.append({'name': _k, 'reason': 'exceeds total snapshot cap'})
        else:
            __repl_e.append({'name': _k, 'kind': __repl_kind, 'payload': __repl_p})
            __repl_total += __repl_b
    except Exception as _e:
        __repl_f.append({'name': _k, 'reason': str(_e)})
"""
            + "get_ipython().display_pub.publish({" + json.dumps(SNAPSHOT_MIME) + ": _js.dumps({'version': 2, 'entries': __repl_e, 'failed': __repl_f})})\n")


def _restore_body(name, kind, payload, compressed):
    n = json.dumps(name)
    if kind == "def":
        # re-execute captured source and register it in linecache under the code
        # so a later snapshot can capture it again
        body = (
            "__repl_src = _b64.b64decode(" + json.dumps(payload) + ").decode()\n"
            + "    exec(__repl_src, globals())\n"
            + "    __repl_obj = globals().get(" + n + ")\n"
            + "    if __repl_obj is not None:\n"
            + "        __repl_fname = getattr(getattr(__repl_obj, '__code__', None), 'co_filename', None)\n"
            + "        if __repl_fname is None:\n"
            + "            __repl_init = getattr(__repl_obj, '__init__', None)\n"
            + "            __repl_fname = getattr(getattr(__repl_init, '__code__', None), 'co_filename', None)\n"
            + "        if __repl_fname:\n"
            + "            _lc.cache[__repl_fname] = (len(__repl_src.splitlines()), None, __repl_src.splitlines(True), __repl_fname)"
        )
    else:
        inner = "_pk.loads(_b64.b64decode(" + json.dumps(payload) + "))"
        if compressed:
            inner = "_pk.loads(_zl.decompress(" + (json.dumps(payload))[0:0] + "_b64.b64decode(" + json.dumps(payload) + ")))"
        body = "globals()[" + n + "] = " + inner
    return ("try:\n    " + body + "\n    __repl_r['restored'].append(" + n + ")\n"
            + "except Exception as _e:\n    __repl_r['failed'].append({'name': " + n + ", 'reason': str(_e)})\n")


def restore_code(entries, compressed_values):
    per = "".join(_restore_body(e["name"], e.get("kind", "value"), e["payload"], compressed_values) for e in entries)
    return ("import pickle as _pk, base64 as _b64, json as _js, zlib as _zl, linecache as _lc\n"
            + "__repl_r = {'restored': [], 'failed': []}\n"
            + per
            + "get_ipython().display_pub.publish({" + json.dumps(RESTORE_MIME) + ": _js.dumps(__repl_r)})\n")


def names_code(helper_names):
    return ("import json as _js\n"
            + "__repl_skip = set(" + skip_set_literal(helper_names) + ")\n"
            + "__repl_n = sorted(n for n in globals() if not n.startswith('_') and n not in __repl_skip)\n"
            + "get_ipython().display_pub.publish({" + json.dumps(NAMES_MIME) + ": _js.dumps(__repl_n)})\n")


class Bridge:
    def __init__(self):
        self.km = None
        self.kc = None
        self.helper_names = []
        self.requests = queue.Queue()
        self.op_id = None          # id of the exec currently streaming, for stream routing
        self.op_payload_mime = None  # private MIME awaited for the current internal cell

    # ----- IO -----

    def emit(self, msg):
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()

    def _stdin_reader(self):
        # BufferedReader.read(n) blocks until n bytes arrive; line iteration returns per line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.requests.put(json.loads(line))
            except Exception as e:
                self.emit({"type": "error", "message": "bad request line: %s" % e})
                self.requests.put({"op": "shutdown", "id": "bad-line"})
        self.requests.put({"op": "__eof__"})

    # ----- kernel lifecycle -----

    def start_kernel(self):
        km = KernelManager(kernel_name="python3")
        try:
            km.start_kernel()
        except NoSuchKernel:
            km = KernelManager(kernel_name="python3", kernel_cmd=[
                sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"])
            km.start_kernel()
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=READY_TIMEOUT_MS / 1000)
        except Exception:
            km.shutdown_kernel(now=True)
            raise
        self.km, self.kc = km, kc

    def stop_kernel(self):
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass

    # ----- cells -----

    def run_cell(self, code, emit_stream, payload_mime=None, emit_id=None):
        """Run one cell; settle on shell reply AND iopub idle (a reply alone can beat big output).
        Returns {status, result?, error?, payload?}. Raises when the kernel died."""
        kc = self.kc
        msg_id = kc.execute(code, silent=False, store_history=False,
                            user_expressions={}, allow_stdin=False, stop_on_error=True)
        self.op_id = msg_id
        self.op_payload_mime = payload_mime
        result = None
        error = None
        payload = None
        quiet_for = 0.0
        try:
            while True:
                # pending interrupts/shutdowns act within one poll cadence
                self._drain_control_queue()
                try:
                    msg = kc.get_iopub_msg(timeout=0.25)
                except Exception:
                    # timeout: poll the heartbeat instead of timing out the whole bridge
                    quiet_for += 0.25
                    if quiet_for >= 2.0:
                        if not self.kernel_alive():
                            self.emit({"type": "dying", "message": "kernel heartbeat lost"})
                            sys.exit(1)
                        quiet_for = 0.0
                    continue
                if msg.get("parent_header", {}).get("msg_id") != msg_id:
                    continue
                quiet_for = 0.0
                ctype = msg["msg_type"]
                content = msg["content"]
                if ctype == "stream":
                    if emit_stream:
                        self.emit({"type": "stream", "id": emit_id or msg_id, "name": "stderr" if content.get("name") == "stderr" else "stdout", "text": content.get("text") or ""})
                elif ctype == "execute_result":
                    data = content.get("data") or {}
                    if "text/plain" in data:
                        result = data["text/plain"]
                    payload = self._take_payload(content)
                elif ctype == "display_data":
                    payload = self._take_payload(content)
                elif ctype == "error":
                    error = {
                        "name": content.get("ename") or "Error",
                        "message": content.get("evalue") or "",
                        "stack": content.get("traceback") or [],
                    }
                elif ctype == "status" and content.get("execution_state") == "idle":
                    break
        except Exception as e:
            if not self.kernel_alive():
                self.emit({"type": "dying", "message": "kernel died mid-cell"})
                sys.exit(1)
            raise
        status = "ok"
        reply = None
        for _ in range(20):
            try:
                candidate = kc.get_shell_msg(timeout=10)
            except Exception:
                break
            if candidate.get("parent_header", {}).get("msg_id") == msg_id:
                reply = candidate
                break
            # stale reply from an earlier op (a late kernel_info, or an "incomplete
            # input" error flushed by this request): drain it, keep looking
        if reply:
            status = reply.get("content", {}).get("status", "ok")
        if status != "aborted" and error is not None:
            # iopub error wins over an "ok" reply (ipykernel: compile-phase failures reply ok)
            status = "error"
        if status == "error" and error is None:
            c = reply.get("content", {})
            error = {"name": c.get("ename") or "Error", "message": c.get("evalue") or "cell failed", "stack": []}
        if status == "aborted" and error is None:
            error = {"name": "KeyboardInterrupt", "message": "cell interrupted", "stack": []}
        self.op_id = None
        self.op_payload_mime = None
        return {"status": status, "result": result, "error": error, "payload": payload}

    def _take_payload(self, content):
        data = content.get("data") or {}
        mime = self.op_payload_mime
        if mime is not None and mime in data:
            return data[mime]
        return None

    def _drain_control_queue(self):
        # control-plane ops may jump the queue mid-cell; anything else is left in order
        while True:
            try:
                op = self.requests.get_nowait()
            except queue.Empty:
                break
            if op["op"] == "interrupt":
                self.interrupt()
            elif op["op"] in ("shutdown", "__eof__"):
                self.stop_kernel()
                sys.exit(0)
            else:
                self.requests.put(op)
                break

    def interrupt(self):
        # BlockingKernelClient has no interrupt() in jupyter_client 8.x; the old host sent
        # interrupt_request on the control channel directly — do the same
        msg = self.kc.session.msg("interrupt_request", content={})
        self.kc.control_channel.send(msg)

    def kernel_alive(self):
        try:
            return self.km.is_alive()
        except Exception:
            return False

    # ----- ops -----

    def op_boot(self, helpers):
        self.helper_names = [h["name"] for h in helpers]
        self.start_kernel()
        report = []
        for h in helpers:
            res = self.run_cell(h["source"], emit_stream=False)
            if res["status"] == "ok":
                report.append({"name": h["name"], "ok": True})
            else:
                err = res["error"] or {}
                report.append({"name": h["name"], "ok": False,
                               "error": (err.get("name") + ": " + err.get("message", "")).strip() or "failed to load"})
        self.emit({"type": "ready", "helpers": report})

    def op_exec(self, op):
        res = self.run_cell(op["code"], emit_stream=True, emit_id=op["id"])
        out = {"type": "result", "id": op["id"], "status": res["status"]}
        if res["result"] is not None:
            out["result"] = res["result"]
        if res["error"] is not None:
            out["error"] = res["error"]
        self.emit(out)

    def op_snapshot(self, op):
        res = self.run_cell(snapshot_code(self.helper_names, op["max_bytes"]), emit_stream=False,
                            payload_mime=SNAPSHOT_MIME)
        payload = res["payload"]
        if payload is None:
            self.emit({"type": "reply", "id": op["id"], "saved": [], "failed": [], "complete": False, "bytes": 0})
            return
        body = json.loads(payload)
        entries, failed = body.get("entries", []), body.get("failed", [])
        # atomic write: temp + rename, so a crash can't corrupt the last good snapshot
        os.makedirs(os.path.dirname(op["path"]) or ".", exist_ok=True)
        tmp = op["path"] + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 3, "entries": entries, "failed": failed}, fh)
        os.replace(tmp, op["path"])
        self.emit({"type": "reply", "id": op["id"],
                   "saved": [e["name"] for e in entries], "failed": failed,
                   "complete": True, "bytes": sum(len(e["payload"]) for e in entries)})

    def op_restore(self, op):
        try:
            with open(op["path"], encoding="utf-8") as fh:
                body = json.load(fh)
        except Exception as e:
            self.emit({"type": "reply", "id": op["id"], "error": "snapshot unreadable: %s" % e})
            return
        version = body.get("version")
        if version is not None and version >= 2:
            entries = body.get("entries") or []
            failed_at_save = body.get("failed") or []
        else:
            # v1 files (pre-source-capture) restore via plain pickles
            entries = [{"name": n, "kind": "value", "payload": p} for n, p in (body.get("vars") or {}).items()]
            failed_at_save = []
        res = self.run_cell(restore_code(entries, version == 3), emit_stream=False, payload_mime=RESTORE_MIME)
        restored, failed = [], []
        if res["payload"] is not None:
            body2 = json.loads(res["payload"])
            restored, failed = body2.get("restored", []), body2.get("failed", [])
        # merge save-time skips (oversized bindings) so the resume notice names every loss
        seen = {f["name"] for f in failed}
        for f in failed_at_save:
            if f["name"] not in seen:
                failed.append(f)
                seen.add(f["name"])
        self.emit({"type": "reply", "id": op["id"], "restored": restored, "failed": failed})

    def op_names(self, op):
        res = self.run_cell(names_code(self.helper_names), emit_stream=False, payload_mime=NAMES_MIME)
        names = json.loads(res["payload"]) if res["payload"] is not None else []
        self.emit({"type": "reply", "id": op["id"], "names": names})

    # ----- main loop -----

    def serve(self):
        threading.Thread(target=self._stdin_reader, daemon=True).start()
        boot = self.requests.get()
        if boot.get("op") == "__eof__":
            return
        try:
            self.op_boot(boot.get("helpers") or [])
        except Exception as e:
            self.emit({"type": "error", "message": "boot failed: %s" % e})
            sys.exit(1)
        while True:
            op = self.requests.get()
            o = op.get("op")
            if o == "__eof__":
                self.stop_kernel()
                sys.exit(0)
            try:
                if o == "exec":
                    self.op_exec(op)
                elif o == "snapshot":
                    self.op_snapshot(op)
                elif o == "restore":
                    self.op_restore(op)
                elif o == "listNames":
                    self.op_names(op)
                elif o == "interrupt":
                    self.interrupt()
                elif o == "shutdown":
                    self.stop_kernel()
                    sys.exit(0)
                else:
                    self.emit({"type": "error", "id": op.get("id"), "message": "unknown op: %s" % o})
            except Exception as e:
                self.emit({"type": "error", "id": op.get("id"), "message": "%s" % e})


def main():
    try:
        Bridge().serve()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
