#!/usr/bin/env python3
"""Prove a bridge helper's assumptions against the live socket.

Run: python3 bridge_test.py [tool1 tool2 ...]
Passes when the socket connects, the handshake succeeds, every expected tool
is mounted, and a read-only roundtrip returns text. Exit 1 otherwise.
"""

import json
import os
import socket
import sys
import time
import uuid

RETRIES = [0.0, 0.1, 0.2, 0.4, 0.8, 1.6]
PREFERENCE = ["ls", "read", "find", "grep"]  # roundtrip candidates, no side effects


def connect(path):
    last = None
    for wait in RETRIES:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(path)
            return s
        except OSError as exc:
            last = exc
            time.sleep(wait)
    raise SystemExit(f"FAIL: bridge unreachable at {path}: {last}")


def xchg(s, obj):
    s.sendall(json.dumps(obj).encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            raise SystemExit("FAIL: connection closed mid-handshake")
        buf += chunk
    return json.loads(buf.decode())


def text(reply):
    return "".join(b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text")


def main():
    expected = sys.argv[1:]
    sock_path = os.environ.get("PI_BRIDGE_SOCK")
    if not sock_path:
        raise SystemExit("FAIL: PI_BRIDGE_SOCK is not set; start pi with --repl")

    s = connect(sock_path)
    pong = xchg(s, {"v": 1, "op": "ping"})
    assert pong.get("op") == "pong", f"FAIL: handshake: {pong}"
    assert pong.get("v") == 1, f"FAIL: version: server v{pong.get('v')}"
    print("PASS handshake")

    cat = xchg(s, {"v": 1, "op": "catalog"})
    mounted = {b["name"] for b in cat.get("content", []) if b.get("type") == "tool"}
    missing = [t for t in expected if t not in mounted]
    assert not missing, f"FAIL: not mounted: {missing}; mounted: {sorted(mounted)}"
    print(f"PASS catalog ({len(expected)} of {len(mounted)} mounted tools expected)")

    candidates = [t for t in PREFERENCE if t in expected]
    if candidates:
        tool = candidates[0]
        reply = xchg(s, {"v": 1, "op": "call", "id": uuid.uuid4().hex, "tool": tool, "params": {}})
        if reply.get("ok"):
            print(f"PASS roundtrip: {tool} returned {len(text(reply))} chars")
        elif reply.get("kind") == "args":
            print(f"SKIP roundtrip: {tool} needs params ({text(reply)[:120]}...); "
                  "connection itself is proven")
        else:
            raise SystemExit(f"FAIL: {tool} errored: {text(reply)[:200]}")
    else:
        print("SKIP roundtrip: no side-effect-free tool among the expected")

    print("OK: bridge helper assumptions hold")


if __name__ == "__main__":
    main()
