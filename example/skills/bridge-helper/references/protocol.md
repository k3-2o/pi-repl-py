# pi-bridge wire protocol

Read this before writing any socket code in a helper or its test.

## Transport

- Unix socket at `PI_BRIDGE_SOCK` (set by the pi-bridge extension before the
  kernel spawns; per-session path under `~/.pi/agent/pi-bridge/run/`)
- Newline-framed JSON, one message per line, request then reply
- Protocol version: `1` (the `v` field on every message)

## Ops

| Op | Request | Reply |
|---|---|---|
| handshake | `{"v":1,"op":"ping"}` | `{"v":1,"op":"pong"}` |
| catalog | `{"v":1,"op":"catalog"}` | `{"ok":true,"content":[{"type":"tool","name","signature","description"}]}` |
| call | `{"v":1,"op":"call","id":"<uuid>","tool":"<name>","params":{...}}` | `{"ok":true,"content":[{"type":"text","text":...}],"details":{...}}` |

Rules: ping before anything else; if the reply's `v` differs from yours, stop
with one loud error naming both versions. Never call before the handshake.

## Replies and failures

- Success: `ok:true`, `content` text blocks, optional `details` carrying machine
  hints (`truncated`, `nextOffset` for paging; image counts)
- Bad args: `ok:false`, `kind:"args"`, `error` is pi's verbatim schema message
  plus the schema-derived signature
- Unknown tool: `ok:false`, `kind:"unknown_tool"`, `error` lists what is mounted
  (with a did-you-mean when close)
- Tool failure: `ok:true` with `isError:true` and the tool's own message in text
- Mid-call connection loss: the call MAY have executed; surface one loud message,
  never retry blindly

## Connect-phase reliability

Retry connect 5 times with backoff 100/200/400/800/1600 ms before surfacing.
Connect retries are invisible when they succeed. The client returns text as-is:
all formatting happened host-side.
