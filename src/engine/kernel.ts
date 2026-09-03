import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "./helpers-locate.js";
import {
	type ConnectionFile,
	executeRequest,
	isTrustedMessage,
	JupyterSession,
	NAMES_MIME,
	type ParsedMessage,
	RESTORE_MIME,
	readConnectionFile,
	readPayload,
	SNAPSHOT_MIME,
} from "./session.js";
import { ZmtpSocket } from "./zmtp.js";

const KERNEL_READY_TIMEOUT_MS = 30_000;
const SILENCE_KILL_GRACE_MS = 2000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

export interface KernelOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Silence watchdog in ms; 0 = no cap (a silent-but-working cell may run on). */
	timeoutMs?: number;
}

export interface CellResult {
	stdout: string;
	stderr: string;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	status: "ok" | "error" | "aborted";
	truncated?: { stdout: boolean; stderr: boolean };
}

export interface CellOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	maxOutputChars?: number;
}

export interface SnapshotEntry {
	name: string;
	/** "value" = zlib-compressed pickle (v3 files; v2 are plain); "def" re-executes captured source (functions and classes). */
	kind: "value" | "def";
	payload: string;
}

export interface SnapshotReply {
	entries: SnapshotEntry[];
	failed: { name: string; reason: string }[];
	complete: boolean;
}

export interface HelperLoadResult {
	name: string;
	ok: boolean;
	/** First error line, e.g. "NameError: name 'x' is not defined"; undefined when ok. */
	error?: string;
}

/** Read the helpers dir (same skip rules as the extension's prompt loader). */
/** Kernel cwd falls back to the host cwd when the requested dir is gone (a deleted project is a real resume case). */
function resolveCwd(requested?: string): string {
	if (requested && existsSync(requested)) return requested;
	return process.cwd();
}
function readHelperSources(dirs: string[]): { name: string; source: string }[] {
	// --- merged dirs come pre-ordered (project first, global last); first-seen name wins ---
	const seen = new Set<string>();
	const out: { name: string; source: string }[] = [];
	for (const d of dirs) {
		if (!existsSync(d)) continue;
		for (const file of readdirSync(d).sort()) {
			if (!file.endsWith(".py")) continue;
			const name = file.slice(0, -3);
			if (!/^[A-Za-z_]\w*$/.test(name) || name.startsWith("_")) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			try {
				out.push({ name, source: readFileSync(join(d, file), "utf8") });
			} catch {}
		}
	}
	return out;
}

function buildSkipList(helperNames: string[]): string {
	const names = new Set([...helperNames, "helper_description", "In", "Out", "get_ipython", "exit", "quit", "open"]);
	return JSON.stringify([...names]);
}

function snapshotCode(helperNames: string[], maxBytes: number): string {
	const skip = buildSkipList(helperNames);
	// --- defs/classes can't be pickled by reference: capture source and re-exec on restore; oversized entries are skipped by name ---
	return `import pickle as _pk, base64 as _b64, json as _js, zlib as _zl, inspect as _in, linecache as _lc
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
__repl_skip = set(${skip})
__repl_max = ${maxBytes}
__repl_e = []
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
get_ipython().display_pub.publish({${JSON.stringify(SNAPSHOT_MIME)}: _js.dumps({'version': 2, 'entries': __repl_e, 'failed': __repl_f})})`;
}

function restoreCode(entries: SnapshotEntry[], compressedValues: boolean): string {
	const per = entries
		.map(({ name, kind, payload }) => {
			const n = JSON.stringify(name);
			const body =
				kind === "def"
					? // re-execute captured source and register it in linecache under the code
						// --- exec also registers the source in linecache so a later snapshot can capture it again ---
						`__repl_src = _b64.b64decode(${JSON.stringify(payload)}).decode()
    exec(__repl_src, globals())
    __repl_obj = globals().get(${n})
    if __repl_obj is not None:
        __repl_fname = getattr(getattr(__repl_obj, '__code__', None), 'co_filename', None)
        if __repl_fname is None:
            __repl_init = getattr(__repl_obj, '__init__', None)
            __repl_fname = getattr(getattr(__repl_init, '__code__', None), 'co_filename', None)
        if __repl_fname:
            _lc.cache[__repl_fname] = (len(__repl_src.splitlines()), None, __repl_src.splitlines(True), __repl_fname)`
					: compressedValues
						? `globals()[${n}] = _pk.loads(_zl.decompress(_b64.b64decode(${JSON.stringify(payload)})))`
						: `globals()[${n}] = _pk.loads(_b64.b64decode(${JSON.stringify(payload)}))`;
			return `try:
    ${body}
    __repl_r['restored'].append(${n})
except Exception as _e:
    __repl_r['failed'].append({'name': ${n}, 'reason': str(_e)})`;
		})
		.join("\n");
	return `import pickle as _pk, base64 as _b64, json as _js, zlib as _zl, linecache as _lc
__repl_r = {'restored': [], 'failed': []}
${per}
get_ipython().display_pub.publish({${JSON.stringify(RESTORE_MIME)}: _js.dumps(__repl_r)})`;
}

function namesCode(helperNames: string[]): string {
	const skip = buildSkipList(helperNames);
	return (
		"import json as _js\n" +
		`__repl_skip = set(${skip})\n` +
		"__repl_n = sorted(n for n in globals() if not n.startswith('_') and n not in __repl_skip)\n" +
		`get_ipython().display_pub.publish({${JSON.stringify(NAMES_MIME)}: _js.dumps(__repl_n)})\n`
	);
}

interface ActiveCell {
	msgId: string;
	stdout: string[];
	stderr: string[];
	outLen: number;
	errLen: number;
	maxChars: number;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	status: CellResult["status"];
	payloads: Record<string, string>;
	lastActivity: number;
	timedOut: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	resolve(result: CellResult & { payloads: Record<string, string> }): void;
	reject(error: Error): void;
	settled: boolean;
	replySeen: boolean;
	idleSeen: boolean;
	reply?: ParsedMessage;
}

export class KernelClient {
	private child?: ChildProcess;
	private shell?: ZmtpSocket;
	private control?: ZmtpSocket;
	private iopub?: ZmtpSocket;
	private readonly session: JupyterSession;
	private readonly helperSources: { name: string; source: string }[];
	private helperBootReport: HelperLoadResult[] = [];
	private readonly timeoutMs: number;
	private activeCell?: ActiveCell;
	private connectionFilePath?: string;
	private ready = false;
	/** Serializes all kernel ops: one execute at a time, snapshots between cells. */
	private queue: Promise<unknown> = Promise.resolve();
	private _onUnexpectedExit?: () => void;
	get helperReport(): readonly HelperLoadResult[] {
		return this.helperBootReport;
	}

	/** Engine hook: an unexpected kernel death (not a deliberate kill) should drop the instance. */
	setOnUnexpectedExit(fn: () => void): void {
		this._onUnexpectedExit = fn;
	}
	private watchdog?: ReturnType<typeof setInterval>;
	private silenceKillTimer?: ReturnType<typeof setTimeout>;
	private pendingReplies = new Map<
		string,
		{ resolve(m: ParsedMessage): void; timer?: ReturnType<typeof setTimeout>; expectedType: string }
	>();

	private constructor(conn: ConnectionFile, opts: KernelOptions) {
		this.session = new JupyterSession({ key: conn.key });
		this.helperSources = opts.env?.PI_HELPERS_DIR
			? readHelperSources([opts.env.PI_HELPERS_DIR])
			: readHelperSources(resolveHelperDirs(opts.cwd, opts.env?.PI_HELPERS_GLOBAL_DIR));
		this.timeoutMs = opts.timeoutMs ?? 0;
	}

	static async start(pythonPath: string, opts: KernelOptions = {}): Promise<KernelClient> {
		const connPath = join(tmpdir(), `pi-repl-kernel-${randomUUID()}.json`);
		const child = spawn(pythonPath, ["-m", "ipykernel", "-f", connPath, "--no-stdout"], {
			cwd: resolveCwd(opts.cwd),
			env: { ...process.env, ...(opts.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		// --- ipykernel writes the connection file, then serves; keep stderr for post-mortems ---
		let stderrTail = "";
		child.stderr?.on("data", (b: Buffer) => {
			stderrTail = (stderrTail + b.toString()).slice(-4000);
		});

		const deadline = Date.now() + KERNEL_READY_TIMEOUT_MS;
		// --- poll until present AND fully written: existsSync fires before the write finishes ---
		let conn: ConnectionFile;
		while (true) {
			if (child.exitCode !== null) {
				throw new Error(
					`ipykernel exited before writing its connection file (code=${child.exitCode})` +
						(stderrTail ? `\nkernel stderr:\n${stderrTail}` : ""),
				);
			}
			if (Date.now() > deadline) {
				child.kill("SIGKILL");
				throw new Error("ipykernel did not write a valid connection file in time");
			}
			try {
				conn = readConnectionFile(connPath);
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}

		const kc = new KernelClient(conn, opts);
		kc.child = child;
		kc.connectionFilePath = connPath;
		child.on("exit", () => {
			// --- clear child/ready on death so isRunning reflects it and the engine never resumes a zombie ---
			kc.settleActive(new Error("kernel process exited"));
			kc.child = undefined;
			kc.ready = false;
			kc.shell?.close();
			kc.control?.close();
			kc.iopub?.close();
			kc.shell = undefined;
			kc.control = undefined;
			kc.iopub = undefined;
			kc._onUnexpectedExit?.();
		});

		try {
			await kc.connectChannels(conn);
			await kc.probeReady();
			kc.helperBootReport = await kc.preload();
			kc.ready = true;
		} catch (error) {
			kc.kill();
			throw error;
		}
		return kc;
	}

	private async connectChannels(conn: ConnectionFile): Promise<void> {
		if (conn.transport !== "tcp") {
			throw new Error(`unsupported kernel transport "${conn.transport}" (only tcp) — set PI_KERNEL_TRANSPORT=tcp`);
		}
		const [shell, control, iopub] = await Promise.all([
			ZmtpSocket.connect({ host: conn.ip, port: conn.shell_port, socketType: "DEALER" }),
			ZmtpSocket.connect({ host: conn.ip, port: conn.control_port, socketType: "DEALER" }),
			ZmtpSocket.connect({ host: conn.ip, port: conn.iopub_port, socketType: "SUB" }),
		]);
		this.shell = shell;
		this.control = control;
		this.iopub = iopub;
		shell.onMessage = (frames) => this.onShellMessage(frames);
		control.onMessage = (frames) => this.onControlMessage(frames);
		iopub.onMessage = (frames) => this.onIopubMessage(frames);
		iopub.subscribe(Buffer.from([])); // all traffic
	}

	private probeReady(): Promise<void> {
		const msgId = this.session.nextMsgId();
		this.shell?.send(this.session.buildFrames("kernel_info_request", {}, null, msgId));
		return this.waitForReply(msgId, KERNEL_READY_TIMEOUT_MS, "kernel_info_reply").then(() => {});
	}

	/** One cell per helper: a broken helper (syntax error or top-level raise) must cost itself alone, not abort the rest. */
	private async preload(): Promise<HelperLoadResult[]> {
		const report: HelperLoadResult[] = [];
		for (const h of this.helperSources) {
			const res = await this.executeCell(h.source, { maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS });
			if (res.status === "ok") {
				report.push({ name: h.name, ok: true });
			} else {
				const err = res.error;
				report.push({
					name: h.name,
					ok: false,
					error: err ? `${err.name}: ${err.message}` : "failed to load",
				});
			}
		}
		return report;
	}

	private onShellMessage(frames: Buffer[]): void {
		const msg = this.session.parseMessage(frames);
		if (!isTrustedMessage(msg)) return;
		const active = this.activeCell;
		if (msg.msg_type === "execute_reply" && active && msg.parent.msg_id === active.msgId) {
			// --- the shell reply races the iopub stream: record it, settle only after idle ---
			active.reply = msg;
			active.replySeen = true;
			this.maybeSettle(active);
			return;
		}
		if (msg.msg_type === "kernel_info_reply" || msg.msg_type === "execute_reply") this.resolveReply(msg);
	}

	private onControlMessage(frames: Buffer[]): void {
		const msg = this.session.parseMessage(frames);
		if (!isTrustedMessage(msg)) return;
		// interrupt_reply / shutdown_reply — nothing awaits them; keep draining.
		this.resolveReply(msg);
	}

	private onIopubMessage(frames: Buffer[]): void {
		const msg = this.session.parseMessage(frames);
		if (!isTrustedMessage(msg)) return;
		const active = this.activeCell;
		if (!active || msg.parent.msg_id !== active.msgId) return;
		active.lastActivity = Date.now();
		const c = msg.content;
		switch (msg.msg_type) {
			case "stream": {
				const text = (c.text as string) ?? "";
				this.accumulate(active, c.name === "stderr" ? "stderr" : "stdout", text);
				break;
			}
			case "execute_result": {
				const data = c.data as Record<string, unknown> | undefined;
				const plain = data?.["text/plain"];
				if (typeof plain === "string") active.result = plain;
				this.collectPayload(active, c);
				break;
			}
			case "display_data":
				this.collectPayload(active, c);
				break;
			case "error": {
				const traceback = Array.isArray(c.traceback) ? (c.traceback as string[]) : [];
				active.error = {
					name: (c.ename as string) ?? "Error",
					message: (c.evalue as string) ?? traceback.join("\n"),
					stack: traceback,
				};
				break;
			}
			case "status":
				// --- status idle is published after every byte; the cell is complete only once we have it ---
				if (c.execution_state === "idle") {
					active.idleSeen = true;
					this.maybeSettle(active);
				}
				break;
		}
	}

	private collectPayload(active: ActiveCell, content: Record<string, unknown>): void {
		for (const mime of [SNAPSHOT_MIME, RESTORE_MIME, NAMES_MIME]) {
			const payload = readPayload(content, mime);
			if (payload !== null) {
				active.payloads[mime] = payload;
				return;
			}
		}
	}

	private accumulate(active: ActiveCell, name: "stdout" | "stderr", text: string): void {
		const arr = name === "stdout" ? active.stdout : active.stderr;
		const len = name === "stdout" ? active.outLen : active.errLen;
		const room = active.maxChars - len;
		const keep = Math.min(text.length, Math.max(0, room));
		if (keep > 0) {
			arr.push(text.slice(0, keep));
			if (name === "stdout") active.outLen += keep;
			else active.errLen += keep;
		}
		// --- one oversized stream frame (10 MB print) overflows the cap within this call ---
		if (text.length > keep) {
			if (name === "stdout") active.stdoutTruncated = true;
			else active.stderrTruncated = true;
		}
		// --- beyond the cap we drop text but keep draining ---
		active.onStream?.(text.slice(0, keep), name);
	}

	private waitForReply(msgId: string, timeoutMs: number, expectedType: string): Promise<ParsedMessage> {
		return new Promise<ParsedMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingReplies.delete(msgId);
				reject(new Error(`kernel did not answer ${expectedType} in time`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingReplies.set(msgId, { resolve, timer, expectedType });
		});
	}

	private resolveReply(msg: ParsedMessage): void {
		const pending = this.pendingReplies.get(msg.parent.msg_id as string);
		if (!pending) return;
		// --- any reply echoes the parent id; only the awaited type settles the wait, the timer stays armed for it ---
		if (msg.msg_type !== pending.expectedType) return;
		this.pendingReplies.delete(msg.parent.msg_id as string);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(msg);
	}

	executeCell(code: string, opts: CellOptions = {}): Promise<CellResult> {
		return this.enqueue(() => this.executeCellNow(code, opts)).then(({ payloads: _payloads, ...rest }) => rest);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	private executeCellNow(code: string, opts: CellOptions): Promise<CellResult & { payloads: Record<string, string> }> {
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		// --- one msg_id per request; the kernel echoes it as the reply's parent for routing ---
		const msgId = this.session.nextMsgId();
		const active: ActiveCell = {
			msgId,
			stdout: [],
			stderr: [],
			outLen: 0,
			errLen: 0,
			maxChars,
			payloads: {},
			lastActivity: Date.now(),
			timedOut: false,
			stdoutTruncated: false,
			stderrTruncated: false,
			signal: opts.signal,
			onStream: opts.onStream,
			status: "ok",
			settled: false,
			replySeen: false,
			idleSeen: false,
			resolve: () => {},
			reject: () => {},
		};
		this.activeCell = active;
		const onAbort = () => this.interrupt();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		this.shell?.send(this.session.buildFrames("execute_request", executeRequest(code, false), null, msgId));
		this.startWatchdog(active);

		return new Promise<CellResult & { payloads: Record<string, string> }>((resolve, reject) => {
			active.resolve = (result) => resolve(result);
			active.reject = reject;
			if (opts.signal?.aborted) this.interrupt();
		}).finally(() => {
			if (this.activeCell === active) this.activeCell = undefined;
			this.stopWatchdog();
			opts.signal?.removeEventListener("abort", onAbort);
		});
	}

	private settleActive(error: Error): void {
		const active = this.activeCell;
		if (!active || active.settled) return;
		active.settled = true;
		active.reject(error);
	}

	private maybeSettle(active: ActiveCell): void {
		// --- settle only once the shell reply AND the idle iopub stream arrive, else output is dropped ---
		if (active.settled || !active.replySeen || !active.idleSeen) return;
		this.settleFromReply(active, active.reply!);
	}

	private settleFromReply(active: ActiveCell, msg: ParsedMessage): void {
		if (active.settled) return;
		active.settled = true;
		const content = msg.content;
		const replyStatus = (content.status as string) ?? "ok";
		if (replyStatus === "error" && !active.error) {
			active.error = {
				name: (content.ename as string) ?? "Error",
				message: (content.evalue as string) ?? "error",
				stack: [],
			};
		}
		let status: CellResult["status"] = replyStatus === "aborted" ? "aborted" : active.error ? "error" : "ok";
		if (active.signal?.aborted) {
			// --- the caller withdrew; report aborted even if the cell raised ---
			status = "aborted";
		} else if (active.timedOut) {
			// --- silence watchdog tripped: the cell was still running, not done ---
			status = "error";
			active.error = {
				name: "Timeout",
				message: "cell did not finish within the silence window and may still be running",
				stack: ["[cell timed out]"],
			};
		}
		active.status = status;
		active.resolve({
			stdout: active.stdout.join(""),
			stderr: active.stderr.join(""),
			result: active.result,
			error: active.error,
			status,
			truncated: { stdout: active.stdoutTruncated, stderr: active.stderrTruncated },
			payloads: active.payloads,
		});
	}

	private startWatchdog(active: ActiveCell): void {
		this.stopWatchdog();
		if (!this.timeoutMs) return;
		this.watchdog = setInterval(
			() => {
				const quiet = Date.now() - active.lastActivity;
				if (quiet >= this.timeoutMs && !active.settled) {
					active.timedOut = true;
					this.interrupt();
					// --- a cell that swallows the interrupt never replies; escalate to a kill so the queue frees ---
					this.silenceKillTimer ??= setTimeout(() => {
						if (!active.settled) this.kill();
					}, SILENCE_KILL_GRACE_MS);
					this.silenceKillTimer.unref?.();
				}
			},
			Math.min(250, this.timeoutMs),
		);
		this.watchdog.unref?.();
	}

	private stopWatchdog(): void {
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = undefined;
		}
		if (this.silenceKillTimer) {
			clearTimeout(this.silenceKillTimer);
			this.silenceKillTimer = undefined;
		}
	}

	/** Genuine KeyboardInterrupt via control-channel interrupt_request; the kernel survives. */
	interrupt(): void {
		const active = this.activeCell;
		if (!active || active.settled) return;
		this.control?.send(this.session.buildFrames("interrupt_request", {}, null));
	}

	snapshot(maxBytes: number): Promise<SnapshotReply> {
		return this.enqueue(async () => {
			const res = await this.executeCellNow(
				snapshotCode(
					this.helperSources.map((h) => h.name),
					maxBytes,
				),
				{
					maxOutputChars: 8_000_000,
				},
			);
			const payload = res.payloads[SNAPSHOT_MIME];
			if (payload === undefined) return { entries: [], failed: [], complete: false };
			try {
				const obj = JSON.parse(payload) as {
					entries?: SnapshotEntry[];
					failed?: { name: string; reason: string }[];
				};
				return { entries: obj.entries ?? [], failed: obj.failed ?? [], complete: true };
			} catch {
				return { entries: [], failed: [], complete: false };
			}
		});
	}

	restore(
		entries: SnapshotEntry[],
		compressedValues = false,
	): Promise<{ restored: string[]; failed: { name: string; reason: string }[] }> {
		if (entries.length === 0) return Promise.resolve({ restored: [], failed: [] });
		return this.enqueue(async () => {
			const res = await this.executeCellNow(restoreCode(entries, compressedValues), { maxOutputChars: 8_000_000 });
			const payload = res.payloads[RESTORE_MIME];
			if (payload === undefined) return { restored: [], failed: [] };
			try {
				const obj = JSON.parse(payload) as { restored?: string[]; failed?: { name: string; reason: string }[] };
				return { restored: obj.restored ?? [], failed: obj.failed ?? [] };
			} catch {
				return { restored: [], failed: [] };
			}
		});
	}

	listNames(): Promise<string[]> {
		return this.enqueue(async () => {
			const res = await this.executeCellNow(namesCode(this.helperSources.map((h) => h.name)), {
				maxOutputChars: 8_000_000,
			});
			const payload = res.payloads[NAMES_MIME];
			if (payload === undefined) return [];
			try {
				const arr = JSON.parse(payload) as unknown;
				return Array.isArray(arr) ? (arr as string[]) : [];
			} catch {
				return [];
			}
		});
	}

	/** Graceful stop: shutdown_request on control, then SIGKILL as backstop. */
	async shutdown(): Promise<void> {
		const child = this.child;
		if (this.ready && this.control && child && child.exitCode === null) {
			this.control.send(this.session.buildFrames("shutdown_request", { restart: false }, null));
			await Promise.race([this.childExit(), new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]).catch(
				() => {},
			);
		}
		this.kill();
	}

	private childExit(): Promise<void> {
		const child = this.child;
		if (!child) return Promise.resolve();
		return child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", () => resolve()));
	}

	kill(): void {
		this.stopWatchdog();
		this.settleActive(new Error("kernel killed"));
		this.shell?.close();
		this.control?.close();
		this.iopub?.close();
		this.child?.kill("SIGKILL");
		this.child = undefined;
		if (this.connectionFilePath) {
			try {
				rmSync(this.connectionFilePath, { force: true });
			} catch {}
			this.connectionFilePath = undefined;
		}
	}

	get isRunning(): boolean {
		return this.ready && this.child !== undefined;
	}
}
