#!/usr/bin/env python3
"""Read the pi-bridge catalog from the live socket and print it as JSON.

Usage: catalog.py [--sock PATH]
Prints a JSON array: [{"name", "signature", "description"}]. Exit 1 with a
clear message when the socket is missing or the handshake fails.
"""

import argparse
import json
import os
import socket
import sys
import time

RETRIES = [0.0, 0.1, 0.2, 0.4, 0.8, 1.6]


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
    raise SystemExit(f"pi-bridge unreachable at {path} after {len(RETRIES)} attempts: {last}")


def xchg(s, obj):
    s.sendall(json.dumps(obj).encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            raise SystemExit("connection closed before reply")
        buf += chunk
    return json.loads(buf.decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sock", default=os.environ.get("PI_BRIDGE_SOCK"))
    args = ap.parse_args()
    if not args.sock:
        raise SystemExit(
            "PI_BRIDGE_SOCK is not set. Start pi with --repl so the pi-bridge "
            "extension boots and sets it."
        )
    s = connect(args.sock)
    pong = xchg(s, {"v": 1, "op": "ping"})
    if pong.get("op") != "pong":
        raise SystemExit(f"handshake failed: {pong}")
    if pong.get("v") != 1:
        raise SystemExit(f"protocol version mismatch: server v{pong.get('v')}, client v1")
    cat = xchg(s, {"v": 1, "op": "catalog"})
    tools = [
        {"name": b["name"], "signature": b.get("signature", ""), "description": b.get("description", "")}
        for b in cat.get("content", [])
        if b.get("type") == "tool"
    ]
    print(json.dumps(tools, indent=2))


if __name__ == "__main__":
    main()
