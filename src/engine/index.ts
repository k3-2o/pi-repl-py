// --- EngineManager: the host half of pi-repl's evaluator ---
//
// Orchestration over KernelClient (src/engine/kernel.ts), which speaks the
// standard Jupyter protocol directly to a real ipykernel subprocess over ZMTP
// (src/engine/zmtp.ts + session.ts). There is no guest.py middleman anymore:
// the fd3 JSON protocol and its nonce existed only because the host did not
// speak the kernel's own protocol, and are gone with it.
//
// This class keeps the parts that are about *managing* the evaluator, not
// about the wire: the venv resolution, lazy spawn, the execution queue,
// snapshot debounce + file persistence, output truncation markers, abort
// grace (interrupt, then kill as backstop), and process-wide teardown.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelClient } from "./kernel.js";

const GUEST_REL = fileURLToPath(new URL("./kernel.js", import.meta.url));

function installVenvPython(): string {
	return join(homedir(), ".pi", "agent", "pi-repl", "venv", "bin", "python3");
}

/** Prefer a venv with ipykernel; else $PYTHON or python3. */
function resolvePythonPath(cwd: string | undefined): string {
	const repoVenv = join(dirname(GUEST_REL), "..", "..", ".venv", "bin", "python3");
	if (existsSync(repoVenv)) return repoVenv;
	const cwdVenv = cwd ? join(cwd, ".venv", "bin", "python3") : "";
	if (cwdVenv && existsSync(cwdVenv)) return cwdVenv;
	const installVenv = installVenvPython();
	if (existsSync(installVenv)) return installVenv;
	return process.env.PYTHON ?? "python3";
}

const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const ABORT_GRACE_MS = 500;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;

interface EngineExecuteError {
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
	/** Aborting cancels the cell via kernel interrupt; the namespace is preserved. */
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
	env?: Record<string, string>;
	/** Persist/revive the namespace across engine restarts. */
	snapshot?: {
		path: string;
		/** Debounce for the auto-snapshot after each ok cell. Default 1500 ms. */
		debounceMs?: number;
	};
}

// --- process-wide cleanup: kernels killed on exit (a child does not die with
// its parent; the old guest self-exited on stdin EOF, a plain ipykernel won't) ---

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private kernel?: KernelClient;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private snapshotTimer?: ReturnType<typeof setTimeout>;
	private pythonPath?: string;

	constructor(options: EngineOptions = {}) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.state === "running" && (this.kernel?.isRunning ?? false);
	}

	//--- lifecycle ---

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
		this.pythonPath = resolvePythonPath(this.options.cwd);
		const timeoutMs = Number(process.env.PI_REPL_TIMEOUT_MS ?? this.options.env?.PI_REPL_TIMEOUT_MS ?? 0) || 0;
		try {
			this.kernel = await KernelClient.start(this.pythonPath, {
				cwd: this.options.cwd,
				env: this.options.env,
				timeoutMs,
			});
		} catch (error) {
			if (this.state === "starting") this.state = "idle";
			liveEngines.delete(this);
			throw error;
		}
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if (this.state === "shutdown") {
			this.kernel?.kill();
			this.kernel = undefined;
			throw new Error("Engine has been shut down");
		}
		this.state = "running";
	}

	/** Abrupt teardown: SIGKILL the kernel; safe from process.on("exit"). */
	killSync(): void {
		this.clearSnapshotTimer();
		this.state = "shutdown";
		liveEngines.delete(this);
		this.kernel?.kill();
		this.kernel = undefined;
	}

	async kill(): Promise<void> {
		this.killSync();
	}

	/** Graceful cleanup: flush a final snapshot, then terminate the kernel. */
	async dispose(): Promise<void> {
		if (this.state === "running") {
			await this.snapshotState().catch(() => null);
		}
		await this.kernel?.shutdown();
		this.killSync();
	}

	//--- execute ---

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
			if (this.state === "shutdown") {
				throw new Error("Engine has been shut down");
			}

			const started = Date.now();
			const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
			let aborted = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				aborted = true;
				this.kernel?.interrupt();
				// --- interrupt is real (KeyboardInterrupt in the kernel), but a
				// cell wedged in C code ignores it; then kill and rebuild ---
				graceTimer = setTimeout(() => {
					if (this.state === "running" && this.kernel) {
						this.state = "shutdown";
						this.kernel.kill();
						this.kernel = undefined;
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const r = await this.kernel!.executeCell(code, {
					signal: opts.signal,
					onStream: opts.onStream,
					maxOutputChars: maxChars,
				});
				if (r.status === "ok") this.scheduleSnapshot();
				const status: ExecuteResult["status"] = opts.signal?.aborted ? "aborted" : r.status;
				const truncate = (text: string, truncated: boolean) => truncateWithMarker(text, maxChars, truncated);
				return {
					stdout: truncate(r.stdout, r.truncated?.stdout ?? false),
					stderr: truncate(r.stderr, r.truncated?.stderr ?? false),
					result: r.result !== undefined ? truncate(String(r.result), String(r.result).length > maxChars) : undefined,
					error: r.error,
					status,
					durationMs: Date.now() - started,
				};
			} catch (error) {
				if (aborted) {
					return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
				}
				throw error;
			} finally {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
			}
		} finally {
			release();
		}
	}

	//--- snapshot / restore / names ---

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running" || !this.kernel) return null;
		try {
			const reply = await this.kernel.snapshot();
			// --- an incomplete snapshot must not overwrite the last good file ---
			if (reply.complete === false) return null;
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
			const payload = JSON.parse(readFileSync(config.path, "utf8")) as { vars?: Record<string, string> };
			const vars = payload.vars ?? {};
			const reply = await this.kernel!.restore(vars);
			return { path: config.path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running" || !this.kernel) return null;
		try {
			return await this.kernel.listNames();
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
