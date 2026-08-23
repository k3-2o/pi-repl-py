// --- KernelClient: one ipykernel subprocess driven directly over ZMTP (no guest middleman). ---

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "./helpers-locate.js";
import {
	type ConnectionFile,
	executeRequest,
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
	/** Per-channel output was capped; the host adds a truncation marker. */
	truncated?: { stdout: boolean; stderr: boolean };
}

export interface CellOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap per-channel output accumulation. Default 1 MiB (the old guest cap). */
	maxOutputChars?: number;
}

export interface SnapshotReply {
	vars: Record<string, string>;
	failed: { name: string; reason: string }[];
	complete: boolean;
}

// --- boot preload: exec each helper; ls()/help() are gone, discovery is globals() ---

/** Read the helpers dir (same skip rules as the extension's prompt loader). */
/** A directory for the kernel to start in; if the requested cwd is gone, fall back to the
 * evaluator's own cwd rather than letting spawn() die with ENOENT. A deleted project dir is
 * a real resume case (pi guards it too) — the kernel must still come up. */
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

function snapshotCode(helperNames: string[]): string {
	const skip = buildSkipList(helperNames);
	return (
		"import pickle as _pk, base64 as _b64, json as _js\n" +
		`__repl_skip = set(${skip})\n` +
		"__repl_v = {}\n__repl_f = []\n" +
		"for _k, _v in list(globals().items()):\n" +
		"    if _k.startswith('_') or _k in __repl_skip:\n" +
		"        continue\n" +
		"    try:\n" +
		"        __repl_v[_k] = _b64.b64encode(_pk.dumps(_v)).decode()\n" +
		"    except Exception as _e:\n" +
		"        __repl_f.append({'name': _k, 'reason': str(_e)})\n" +
		`get_ipython().display_pub.publish({${JSON.stringify(SNAPSHOT_MIME)}: _js.dumps({'vars': __repl_v, 'failed': __repl_f})})\n`
	);
}

function restoreCode(vars_: Record<string, string>): string {
	const entries = Object.entries(vars_)
		.map(([name, b64]) => {
			const n = JSON.stringify(name);
			return (
				`try:\n    globals()[${n}] = _pk.loads(_b64.b64decode(${JSON.stringify(b64)}))\n    __repl_r['restored'].append(${n})\n` +
				`except Exception as _e:\n    __repl_r['failed'].append({'name': ${n}, 'reason': str(_e)})`
			);
		})
		.join("\n");
	return (
		"import pickle as _pk, base64 as _b64, json as _js\n" +
		"__repl_r = {'restored': [], 'failed': []}\n" +
		entries +
		`\nget_ipython().display_pub.publish({${JSON.stringify(RESTORE_MIME)}: _js.dumps(__repl_r)})\n`
	);
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
	/** Private-MIME payloads published by this cell (snapshot/restore/names). */
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
	/** The shell execute_reply arrived (carries the authoritative status). */
	replySeen: boolean;
	/** The matching iopub status idle arrived (published after all output). */
	idleSeen: boolean;
	/** The execute_reply content, held until both halves are seen. */
	reply?: ParsedMessage;
}

export class KernelClient {
	private child?: ChildProcess;
	private shell?: ZmtpSocket;
	private control?: ZmtpSocket;
	private iopub?: ZmtpSocket;
	private readonly session: JupyterSession;
	private readonly helperSources: { name: string; source: string }[];
	private readonly timeoutMs: number;
	private activeCell?: ActiveCell;
	private connectionFilePath?: string;
	private ready = false;
	/** Serializes all kernel ops: one execute at a time, snapshots between cells. */
	private queue: Promise<unknown> = Promise.resolve();
	private _onUnexpectedExit?: () => void;
	/** Engine hook: an unexpected kernel death (not a deliberate kill) should drop the instance. */
	setOnUnexpectedExit(fn: () => void): void {
		this._onUnexpectedExit = fn;
	}
	private watchdog?: ReturnType<typeof setInterval>;
	private silenceKillTimer?: ReturnType<typeof setTimeout>;
	private pendingReplies = new Map<
		string,
		{ resolve(m: ParsedMessage): void; timer?: ReturnType<typeof setTimeout> }
	>();

	private constructor(conn: ConnectionFile, opts: KernelOptions) {
		this.session = new JupyterSession({ key: conn.key });
		this.helperSources = opts.env?.PI_HELPERS_DIR
			? readHelperSources([opts.env.PI_HELPERS_DIR])
			: readHelperSources(resolveHelperDirs(opts.cwd, opts.env?.PI_HELPERS_GLOBAL_DIR));
		this.timeoutMs = opts.timeoutMs ?? 0;
	}

	/** Spawn ipykernel, connect all channels, and wait until it answers. */
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
				// --- not present yet, or mid-write: retry ---
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}

		const kc = new KernelClient(conn, opts);
		kc.child = child;
		kc.connectionFilePath = connPath;
		child.on("exit", () => {
			// --- a dead kernel settles the running cell; the engine rebuilds. clear child/ready
			// --- so isRunning reflects death and the engine never resumes a zombie process. ---
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
			await kc.preload();
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

	/** Exec every helper file into the kernel namespace. No custom intrinsics. */
	private preload(): Promise<void> {
		let code = "";
		for (const h of this.helperSources) code += `\n${h.source}\n`;
		return this.executeCell(code, { maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS }).then(() => {});
	}

	private onShellMessage(frames: Buffer[]): void {
		const msg = this.session.parseMessage(frames);
		if (!msg) return;
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
		if (!msg) return;
		// interrupt_reply / shutdown_reply — nothing awaits them; keep draining.
		this.resolveReply(msg);
	}

	private onIopubMessage(frames: Buffer[]): void {
		const msg = this.session.parseMessage(frames);
		if (!msg) return;
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
			this.pendingReplies.set(msgId, { resolve, timer });
		});
	}

	private resolveReply(msg: ParsedMessage): void {
		const pending = this.pendingReplies.get(msg.parent.msg_id as string);
		if (!pending) return;
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
					// --- the interrupt is a real KeyboardInterrupt, but a cell that swallows/ignores
					// --- it never replies; escalate to a kill so the queue is freed, mirroring index.ts. ---
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

	snapshot(): Promise<SnapshotReply> {
		return this.enqueue(async () => {
			const res = await this.executeCellNow(snapshotCode(this.helperSources.map((h) => h.name)), {
				maxOutputChars: 8_000_000,
			});
			const payload = res.payloads[SNAPSHOT_MIME];
			if (payload === undefined) return { vars: {}, failed: [], complete: false };
			try {
				const obj = JSON.parse(payload) as {
					vars?: Record<string, string>;
					failed?: { name: string; reason: string }[];
				};
				return { vars: obj.vars ?? {}, failed: obj.failed ?? [], complete: true };
			} catch {
				return { vars: {}, failed: [], complete: false };
			}
		});
	}

	restore(vars_: Record<string, string>): Promise<{ restored: string[]; failed: { name: string; reason: string }[] }> {
		if (Object.keys(vars_).length === 0) return Promise.resolve({ restored: [], failed: [] });
		return this.enqueue(async () => {
			const res = await this.executeCellNow(restoreCode(vars_), { maxOutputChars: 8_000_000 });
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
