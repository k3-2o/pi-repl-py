/**
 * EngineManager — the host half of the evaluator.
 *
 * Owns one persistent Python guest, speaks the line-JSON protocol over a
 * private pipe, and exposes the execute / snapshot / restore API the `execute`
 * tool is built on.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	decodeMessage,
	encodeMessage,
	type GuestToHostMessage,
	type HostToGuestMessage,
	NONCE_ENV,
	PROTOCOL_FD,
} from "./protocol.js";

const GUEST_PATH = fileURLToPath(new URL("./guest.py", import.meta.url));

// --- venv created by the package postinstall ---
function installVenvPython(): string {
	return join(homedir(), ".pi", "agent", "pi-repl-venv", "bin", "python3");
}

// --- prefer a venv with ipykernel; else PYTHON or python3 ---
function resolvePythonPath(cwd: string | undefined): string {
	const repoVenv = join(dirname(GUEST_PATH), "..", "..", ".venv", "bin", "python3");
	if (existsSync(repoVenv)) return repoVenv;
	const cwdVenv = cwd ? join(cwd, ".venv", "bin", "python3") : "";
	if (cwdVenv && existsSync(cwdVenv)) return cwdVenv;
	const installVenv = installVenvPython();
	if (existsSync(installVenv)) return installVenv;
	return process.env.PYTHON ?? "python3";
}
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const READY_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 500;
const PING_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

export interface EngineExecuteError {
	/** Error class name, e.g. "TypeError". */
	name: string;
	message: string;
	/** Stack trace, split into lines. */
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Rendered value of the cell's final expression, when it has one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell cooperatively; namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
}

export interface SnapshotResult {
	path: string;
	/** Top-level names successfully serialized. */
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	/** Python interpreter to spawn the guest with. Defaults to the repo venv. */
	pythonPath?: string;
	/** Directory of toolbox functions to exec into the kernel (PI_TOOLBOX_DIR). */
	toolboxDir?: string;
	/** Per-cell response timeout, ms. Default 60_000. */
	timeoutMs?: number;
	env?: Record<string, string>;
	/** Persist/revive the namespace across engine restarts. */
	snapshot?: {
		path: string;
		/** Debounce for the auto-snapshot after each ok cell. Default 1500 ms. */
		debounceMs?: number;
	};
}

/**
 * Thrown when a cancelled cell is still occupying the evaluator. Cancellation is
 * cooperative; the caller recovers by killing the engine and restoring.
 */
export class EngineBusyError extends Error {
	constructor() {
		super("Engine is still running the previously interrupted cell. Kill the engine to start fresh.");
		this.name = "EngineBusyError";
	}
}

interface ActiveExecution {
	cellId: string;
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	error?: EngineExecuteError;
	status: ExecuteResult["status"];
	settled: boolean;
	/** Set on cancellation: a cancelled cell must stop contributing output at once. */
	abortRequested: boolean;
	/**
	 * Aborts host-side work done on this cell's behalf.
	 */
	hostAbort: AbortController;
	resolve(result: ExecuteResult): void;
	reject(error: Error): void;
}

// ── process-wide cleanup ─────────────────────────────────────────────────────
// Guests are killed on host exit; the guest also self-exits on stdin EOF.

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

interface PendingRequest {
	resolve(message: GuestToHostMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private readonly pythonPath: string;
	private readonly toolboxDir?: string;
	private readonly timeoutMs: number;
	private child?: ChildProcess;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly nonce = randomUUID().replaceAll("-", ""); // --- per-process protocol nonce ---
	private guestStderr = ""; // --- tail of the guest's stderr, for unexpected-death reports ---
	private childClosed?: Promise<void>;
	/** Held so the protocol reader is not garbage-collected mid-session, which
	 * would close the guest's write end and kill it with EPIPE. */
	private protocolReader?: ReturnType<typeof createInterface>;
	private maybeWedged = false;
	private snapshotTimer?: ReturnType<typeof setTimeout>;

	constructor(options: EngineOptions = {}) {
		this.options = options;
		this.pythonPath = options.pythonPath ?? resolvePythonPath(options.cwd);
		this.toolboxDir = options.toolboxDir;
		this.timeoutMs = options.timeoutMs ?? 60_000;
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.state === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// --- keep a startup failure nobody awaits from surfacing as unhandled ---
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		installProcessCleanupOnce();
		liveEngines.add(this);
		const pythonPath = this.pythonPath;
		const child = spawn(pythonPath, [GUEST_PATH], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...(this.options.env ?? {}),
				[NONCE_ENV]: this.nonce,
				PI_REPL_TIMEOUT_MS: String(this.timeoutMs),
				PI_TOOLBOX_DIR: this.toolboxDir ?? "",
			},
			// fd 3 carries protocol; stdout/stderr stay user output.
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Engine guest did not become ready in time")), READY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingRequests.set("__ready__", {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});

		const protocolStream = child.stdio[PROTOCOL_FD] as NodeJS.ReadableStream | null;
		if (!protocolStream) {
			throw new Error("Engine guest was spawned without a protocol pipe on fd 3");
		}
		this.protocolReader = createInterface({ input: protocolStream });
		this.protocolReader.on("line", (line) => this.handleGuestLine(line));
		// Anything the guest writes to the real stdout/stderr fds is subprocess
		// output (Bun.$ without .quiet()); attribute it to the running cell.
		child.stdout!.on("data", (buffer: Buffer) => this.appendActiveOutput("stdout", buffer.toString()));
		child.stderr!.on("data", (buffer: Buffer) => {
			const text = buffer.toString();
			this.guestStderr = (this.guestStderr + text).slice(-4000);
			this.appendActiveOutput("stderr", text);
		});

		child.on("error", (error) => {
			// --- ENOENT names a missing python; say what to install ---
			const message =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "Engine process failed: '" +
						pythonPath +
						"' was not found on PATH. pi-repl runs its evaluator in Python; ensure it is installed and on your PATH, or set the pythonPath in ~/.pi/agent/pi-repl.json."
					: `Engine process failed: ${error.message}`;
			this.failAllPending(new Error(message));
			this.transitionToShutdown(message);
		});
		child.on("exit", (code, signal) => {
			// --- a killed child's exit arrives after teardown already moved on ---
			if (this.child !== child) return;
			if (this.state !== "shutdown") {
				const tail = this.guestStderr.trim();
				const reason =
					`Engine process exited unexpectedly (code=${code} signal=${signal})` +
					(tail ? `\nguest stderr:\n${tail.slice(-1500)}` : "");
				this.failAllPending(new Error(reason));
				this.transitionToShutdown(reason);
			}
		});

		await ready;
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if ((this.state as string) === "shutdown") throw new Error("Engine has been shut down");
		this.state = "running";
	}

	private transitionToShutdown(reason: string): void {
		this.state = "shutdown";
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			this.activeExecution = undefined;
			active.settled = true;
			active.reject(new Error(reason));
		}
	}

	private failAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	async kill(): Promise<void> {
		const closed = this.childClosed;
		this.killSync();
		// --- wait for pipes to close so a fast respawn doesn't recycle descriptors ---
		if (closed) {
			await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())]);
		}
	}

	/** Synchronous teardown, safe from process.on("exit"). */
	killSync(): void {
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			active.status = "aborted";
			this.settleActiveExecution(active);
		}
		this.state = "shutdown";
		liveEngines.delete(this);
		this.failAllPending(new Error("Engine has been shut down"));
		this.child?.kill("SIGKILL");
		this.child = undefined;
		this.protocolReader?.close();
		this.protocolReader = undefined;
	}

	/** Graceful cleanup: flush a final snapshot, then terminate the guest. */
	async dispose(): Promise<void> {
		if (this.state === "running") {
			await this.snapshotState().catch(() => null);
		}
		await this.kill();
	}

	// ── guest messaging ────────────────────────────────────────────────────────

	private sendToGuest(message: HostToGuestMessage): void {
		// --- a write into a dying child can throw; callers learn via the exit path ---
		try {
			this.child?.stdin?.write(encodeMessage(message, this.nonce));
		} catch {}
	}

	private request(message: HostToGuestMessage & { id: string }, timeoutMs: number): Promise<GuestToHostMessage> {
		const pending = new Promise<GuestToHostMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(message.id);
				reject(new Error(`Engine request ${message.type} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingRequests.set(message.id, { resolve, reject, timer });
			this.sendToGuest(message);
		});
		// --- a caller that moved on isn't listening; that rejection could escape as unhandled ---
		pending.catch(() => {});
		return pending;
	}

	private handleGuestLine(line: string): void {
		// fd 3 is protocol-only; a line that fails to decode is discarded.
		const message = decodeMessage<GuestToHostMessage>(line, this.nonce);
		if (!message) return;
		switch (message.type) {
			case "ready": {
				const pending = this.pendingRequests.get("__ready__");
				if (pending) {
					this.pendingRequests.delete("__ready__");
					pending.resolve(message);
				}
				break;
			}
			case "stream": {
				const active = this.activeExecution;
				// --- untagged output belongs to no cell; don't attribute it ---
				if (!active || active.settled || message.cellId !== active.cellId) return;
				this.appendOutput(active, message.name, message.chunk);
				break;
			}
			case "done": {
				const active = this.activeExecution;
				if (!active || active.settled || active.cellId !== message.cellId) return;
				if (message.status === "error") {
					active.status = "error";
					active.error = message.error;
				} else if (message.status === "aborted") {
					active.status = "aborted";
				} else {
					active.result = message.result;
				}
				this.settleActiveExecution(active);
				break;
			}
			case "pong": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "snapshot_result":
			case "restore_result":
			case "names_result": {
				this.resolveRequest(message.id, message);
				break;
			}
		}
	}

	private resolveRequest(id: string, message: GuestToHostMessage): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		this.pendingRequests.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message);
	}

	// ── output accumulation ────────────────────────────────────────────────────

	private appendActiveOutput(name: "stdout" | "stderr", text: string): void {
		const active = this.activeExecution;
		if (!active || active.settled) return;
		this.appendOutput(active, name, text);
	}

	private appendOutput(active: ActiveExecution, name: "stdout" | "stderr", text: string): void {
		if (active.abortRequested) return;
		const key = name === "stdout" ? "stdout" : "stderr";
		const truncatedKey = name === "stdout" ? "stdoutTruncated" : "stderrTruncated";
		if (active[key].length < active.maxChars) {
			active[key] += text;
			if (active[key].length > active.maxChars) {
				active[key] = active[key].slice(0, active.maxChars);
				active[truncatedKey] = true;
			}
		} else {
			active[truncatedKey] = true;
		}
		active.opts.onStream?.(text, name);
	}

	// ── execute ────────────────────────────────────────────────────────────────

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// --- claim the queue slot synchronously so order == submission order ---
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.state === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			if ((this.state as string) === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			if (this.maybeWedged) {
				await this.assertGuestResponsive();
			}
			const result = await this.executeInner(code, opts);
			if (result.status === "ok") this.scheduleSnapshot();
			return result;
		} finally {
			release();
		}
	}

	private async assertGuestResponsive(): Promise<void> {
		try {
			await this.request({ type: "ping", id: randomUUID() }, PING_TIMEOUT_MS);
			this.maybeWedged = false;
		} catch (error) {
			if (this.state === "shutdown" || !this.child) {
				throw new Error("Engine has been shut down");
			}
			void error;
			throw new EngineBusyError();
		}
	}

	private executeInner(code: string, opts: ExecuteOptions): Promise<ExecuteResult> {
		const cellId = randomUUID();
		const started = Date.now();

		return new Promise<ExecuteResult>((resolve, reject) => {
			const active: ActiveExecution = {
				cellId,
				code,
				started,
				maxChars: opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
				opts,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				status: "ok",
				settled: false,
				abortRequested: false,
				hostAbort: new AbortController(),
				resolve,
				reject,
			};
			this.activeExecution = active;

			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				active.abortRequested = true;
				active.hostAbort.abort();
				this.sendToGuest({ type: "abort", cellId });
				this.maybeWedged = true;
				graceTimer = setTimeout(() => {
					if (this.activeExecution === active && !active.settled) {
						active.status = "aborted";
						this.settleActiveExecution(active);
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			const originalResolve = active.resolve;
			active.resolve = (result) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalResolve(result);
			};
			const originalReject = active.reject;
			active.reject = (error) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalReject(error);
			};

			this.sendToGuest({ type: "run", cellId, code });
		});
	}

	private settleActiveExecution(active: ActiveExecution): void {
		if (active.settled) return;
		active.settled = true;
		if (this.activeExecution === active) this.activeExecution = undefined;

		// A cancelled cell reports "aborted" even if it finished first:
		// the caller withdrew interest, so the value is not theirs to consume.
		let status = active.status;
		if (active.opts.signal?.aborted) status = "aborted";
		if (status !== "aborted") this.maybeWedged = false;

		const stdout = truncateWithMarker(active.stdout, active.maxChars, active.stdoutTruncated);
		const stderr = truncateWithMarker(active.stderr, active.maxChars, active.stderrTruncated);
		let result = active.result;
		if (result != null && String(result).length > active.maxChars) {
			result = truncateWithMarker(String(result), active.maxChars, true);
		}

		active.resolve({
			stdout,
			stderr,
			result,
			error: active.error,
			status,
			durationMs: Date.now() - active.started,
		});
	}

	// ── snapshot / restore / names ─────────────────────────────────────────────

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "snapshot", id: randomUUID() }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "snapshot_result") return null;
			mkdirSync(dirname(config.path), { recursive: true });
			writeFileSync(config.path, JSON.stringify({ version: 1, vars: reply.vars, failed: reply.failed }));
			return { path: config.path, saved: Object.keys(reply.vars), failed: reply.failed };
		} catch {
			return null;
		}
	}

	async restoreState(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config) return null;
		if (!existsSync(config.path)) return null;
		await this.start();
		try {
			const payload = JSON.parse(readFileSync(config.path, "utf8")) as {
				vars?: Record<string, string>;
			};
			const vars = payload.vars ?? {};
			const reply = await this.request({ type: "restore", id: randomUUID(), vars }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "restore_result") return null;
			return { path: config.path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "list_names", id: randomUUID() }, PING_TIMEOUT_MS);
			return reply.type === "names_result" ? reply.names : null;
		} catch {
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const config = this.options.snapshot;
		if (!config) return;
		this.clearSnapshotTimer();
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.snapshotState();
		}, config.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		this.snapshotTimer.unref?.();
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}
}
