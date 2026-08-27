// --- EngineManager: the host half of pi-repl's evaluator, driving a real ipykernel over ---
// --- ZMTP directly (no guest.py middleman). Owns venv resolution, spawn, queue,   ---
// --- snapshots, abort grace, and teardown — the wire lives in kernel.ts.         ---

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KernelClient, type SnapshotEntry } from "./kernel.js";

function installVenvPython(): string {
	return join(homedir(), ".pi", "agent", "pi-repl", "venv", "bin", "python3");
}

/** Prefer a venv with ipykernel; else $PYTHON or python3. */
function resolvePythonPath(_cwd: string | undefined): string {
	// Only ever use the install venv: a project or repo `.venv` may lack ipykernel and
	// shadow the good environment, killing the kernel. No auto-picking.
	const installVenv = installVenvPython();
	if (existsSync(installVenv)) return installVenv;
	return process.env.PYTHON ?? "python3";
}

const DEFAULT_MAX_OUTPUT_CHARS = 46080;
/** Per-line cap: one genuinely oversized line must not own the channel budget, while legitimately long
 * REPL output (JSON, reprs, errors) still fits under the cap in one piece. Generous enough that only
 * pathological giant lines are trimmed, unlike pi's grep where the line cap keeps matches terse. */
export const MAX_OUTPUT_LINE_CHARS = 4096;
const ABORT_GRACE_MS = 20_000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
/** Total snapshot size cap (base64 payload). Per-entry entries are capped at the same
 * bound; larger bindings are reported as skipped names. Mirrors the pi-codex scheme. */
const DEFAULT_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;

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
	/** Cap stdout / stderr / result at this many characters. Default 45K. */
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
		/** Total base64 payload cap; also the per-entry cap. Oversized entries are skipped with a reason. Default 128 MiB. */
		maxBytes?: number;
	};
}

// --- process-wide cleanup: a child does not die with its parent, so SIGKILL live kernels on exit ---

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

/** Cap each individual line, so one giant line cannot own the whole channel budget (like grep's line cap). */
export function capLinesForContext(text: string): { text: string; trimmed: boolean } {
	const lines = text.split("\n");
	let trimmed = false;
	const mapped = lines.map((line) => {
		if (line.length <= MAX_OUTPUT_LINE_CHARS) return line;
		trimmed = true;
		return line.slice(0, MAX_OUTPUT_LINE_CHARS);
	});
	return { text: mapped.join("\n"), trimmed };
}

const DEFAULT_KEEP_SNAPSHOTS = 25;

/** Scan the state root for per-session snapshot dirs and delete all but the newest `keep`,
 * so a long-lived machine does not accumulate one directory per session forever. The
 * current session's dir is exempt; a snapshot dir without a usable manifest is ignored. */
export function pruneSnapshotDirs(stateRoot: string, keep: number = DEFAULT_KEEP_SNAPSHOTS, currentDir?: string): void {
	const entries: { dir: string; mtimeMs: number }[] = [];
	try {
		for (const name of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!name.isDirectory() || name.name === currentDir) continue;
			try {
				const manifest = join(stateRoot, name.name, "namespace.snapshot");
				if (!existsSync(manifest)) continue;
				entries.push({ dir: join(stateRoot, name.name), mtimeMs: statSync(manifest).mtimeMs });
			} catch {}
		}
	} catch {
		return;
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { dir } of entries.slice(keep)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

// --- Orphaned-snapshot sweep: snapshot dirs are keyed by conversation file basename, so when
// --- an owning conversation is deleted (pi removes the .jsonl), its directory becomes dead
// --- weight. This drops any state dir whose conversation file exists in NONE of the project
// --- session roots, so deleting a conversation deletes its snapshots with it. Safety rules:
// --- only dirs that look like ours (contain a namespace.snapshot manifest) are touched, and
// --- the live session plus the no-session "ephemeral" fallback dir are always exempt. ---
export function pruneOrphanedSnapshotDirs(
	stateRoot: string,
	sessionsRoot: string | undefined,
	currentDir?: string,
): number {
	if (!sessionsRoot || !existsSync(sessionsRoot)) return 0;
	const liveNames = new Set<string>();
	try {
		for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!proj.isDirectory()) continue;
			for (const f of readdirSync(join(sessionsRoot, proj.name))) {
				if (f.endsWith(".jsonl")) liveNames.add(f.slice(0, -".jsonl".length));
			}
		}
	} catch {
		return 0;
	}
	let removed = 0;
	try {
		for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === currentDir || entry.name === "ephemeral") continue;
			if (liveNames.has(entry.name)) continue;
			if (!existsSync(join(stateRoot, entry.name, "namespace.snapshot"))) continue;
			rmSync(join(stateRoot, entry.name), { recursive: true, force: true });
			removed++;
		}
	} catch {
		// readdir can race a concurrent sweep; give up quietly rather than partial-delete
	}
	return removed;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private kernel?: KernelClient;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private snapshotTimer?: ReturnType<typeof setTimeout>;
	/** User cells currently running on the kernel; the debounced snapshot never cuts in front of one. */
	private inFlightCells = 0;
	/** Last-seen top-level namespace names; snapshots are gated on this set changing. */
	private lastNamespaceNames?: string[];
	private pythonPath?: string;

	constructor(options: EngineOptions = {}) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.state === "running" && (this.kernel?.isRunning ?? false);
	}

	// -- state can change to "shutdown" from kill()/dispose() at any time; read it
	// through a method so TS doesn't narrow the union and flag a false "no overlap" --
	private isShutdown(): boolean {
		return this.state === "shutdown";
	}

	//lifecycle

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
			// --- an unexpected kernel death must not survive the next execute: drop the dying
			// --- instance and clear the boot cache so start() rebuilds it on the next cell. ---
			const current = this.kernel;
			current.setOnUnexpectedExit(() => {
				if (this.kernel !== current) return;
				this.kernel = undefined;
				this.startPromise = undefined;
				this.lastNamespaceNames = undefined;
			});
		} catch (error) {
			if (this.state === "starting") this.state = "idle";
			liveEngines.delete(this);
			throw error;
		}
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if (this.isShutdown()) {
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
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			// --- the kernel may have died after the boot promise resolved but before the async
			// --- exit event surfaced it; drop the zombie and rebuild so the next cell runs. ---
			if (this.kernel && !this.kernel.isRunning) {
				this.kernel = undefined;
				this.startPromise = undefined;
				await this.start();
			}
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}

			const started = Date.now();
			const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
			let aborted = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				aborted = true;
				this.kernel?.interrupt();
				// --- interrupt is a real KeyboardInterrupt, but a C-wedged cell ignores it; then kill+rebuild ---
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

			this.inFlightCells++;
			try {
				const r = await this.kernel!.executeCell(code, {
					signal: opts.signal,
					onStream: opts.onStream,
					maxOutputChars: maxChars,
				});
				// --- names gate runs off the critical path so the next execute's kernel
				// --- request enqueues before the list-names hop, not behind it ---
				if (r.status === "ok") setImmediate(() => void this.scheduleSnapshotIfChanged());
				const status: ExecuteResult["status"] = opts.signal?.aborted ? "aborted" : r.status;
				// Channel cap (truncateWithMarker), then per-line cap; both append a marker so truncation is explicit.
				const finalize = (text: string, channelTruncated: boolean): string => {
					let out = truncateWithMarker(text, maxChars, channelTruncated);
					const line = capLinesForContext(out);
					if (line.trimmed) out = `${line.text}\n[... some lines exceeded ${MAX_OUTPUT_LINE_CHARS} chars ...]`;
					else out = line.text;
					return out;
				};
				return {
					stdout: finalize(r.stdout, r.truncated?.stdout ?? false),
					stderr: finalize(r.stderr, r.truncated?.stderr ?? false),
					result: r.result !== undefined ? finalize(String(r.result), String(r.result).length > maxChars) : undefined,
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
				this.inFlightCells--;
			}
		} finally {
			release();
		}
	}

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running" || !this.kernel) return null;
		try {
			const reply = await this.kernel.snapshot(config.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);
			// --- an incomplete snapshot must not overwrite the last good file ---
			if (reply.complete === false) return null;
			mkdirSync(dirname(config.path), { recursive: true });
			// --- write to a temp file then rename so a crash mid-write can never corrupt
			// --- the last good snapshot (the restore side parses or returns null) ---
			const tmp = `${config.path}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: 2, entries: reply.entries, failed: reply.failed }));
			renameSync(tmp, config.path);
			return { path: config.path, saved: reply.entries.map((e) => e.name), failed: reply.failed };
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
				version?: number;
				entries?: SnapshotEntry[];
				vars?: Record<string, string>;
			};
			// --- version 1 files (pre-source-capture) are still restorable: their vars are plain pickles ---
			const entries: SnapshotEntry[] =
				payload.version === 2
					? (payload.entries ?? [])
					: Object.entries(payload.vars ?? {}).map(([name, b64]) => ({ name, kind: "value", payload: b64 }));
			const reply = await this.kernel!.restore(entries);
			return { path: config.path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		}
	}

	/** The conversation's state dir exists, so this engine is a resume, not a first run. */
	hasSnapshotHistory(): boolean {
		const config = this.options.snapshot;
		return config ? existsSync(dirname(config.path)) : false;
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running" || !this.kernel) return null;
		try {
			return await this.kernel.listNames();
		} catch {
			return null;
		}
	}

	/** Snapshot only if the set of top-level names changed since the last snapshot. Names-only
	 * comparison is cheap (no pickling); a cell that reuses existing state skips the heavy dump. */
	private async scheduleSnapshotIfChanged(): Promise<void> {
		const config = this.options.snapshot;
		if (!config) return;
		const names = await this.listNamespaceNames();
		if (names === null || names.length === 0) return;
		const key = [...names].sort().join(",");
		const prev = this.lastNamespaceNames ? [...this.lastNamespaceNames].sort().join(",") : undefined;
		if (prev !== undefined && prev === key) return; // nothing changed
		this.lastNamespaceNames = [...names].sort();
		this.scheduleSnapshot();
	}

	private scheduleSnapshot(): void {
		const config = this.options.snapshot;
		if (!config) return;
		this.clearSnapshotTimer();
		const quiet = config.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
		const fire = () => {
			this.snapshotTimer = undefined;
			if (this.inFlightCells > 0) {
				// --- a pickling cell would wait ahead of the user's next request on the
				// --- kernel's single queue; the snapshot only lands in a real quiet gap,
				// --- so re-arm the full quiet window and let activity settle instead ---
				this.snapshotTimer = setTimeout(fire, quiet);
				this.snapshotTimer.unref?.();
				return;
			}
			void this.snapshotState();
		};
		this.snapshotTimer = setTimeout(fire, quiet);
		this.snapshotTimer.unref?.();
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}
}
