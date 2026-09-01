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
/** Quiet-gap window before the background restore fires after boot; never ahead of a user cell. */
const RESTORE_QUIET_MS = 250;
/** Deadline for one restore cell (a poisoned pickle can wedge the kernel's single queue for
 * ever). The reaper kills the kernel and marks the restore skipped so the next call rebuilds
 * honestly. Mirrors the boot deadline in the lifecycle; also settable per engine via env. */
const DEFAULT_RESTORE_DEADLINE_MS = 90_000;

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
	/** Do not revive the snapshot on this engine (used after a wedged restore was detected once). */
	skipRestore?: boolean;
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
				if (!f.endsWith(".jsonl")) continue;
				const name = f.slice(0, -".jsonl".length);
				// --- both state-dir formats are live while their conversation lives: the legacy
				// --- bare-name dir (pre-slug upgrade) and the slug-keyed dir (see state-layout) ---
				liveNames.add(name);
				liveNames.add(`${proj.name}__${name}`);
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
	/** The kernel whose namespace has (or is being) revived from the last snapshot. */
	private restoredKernel?: KernelClient;
	/** A wedged revive marks the engine: later kernels on this engine boot without restoring. */
	private restoreSkipped: boolean;
	private restoreTimer?: ReturnType<typeof setTimeout>;
	private restoreResolve?: (result: RestoreResult | null) => void;
	private restorePromise?: Promise<RestoreResult | null>;
	private restoreSettledResult?: RestoreResult | null;

	constructor(options: EngineOptions = {}) {
		this.options = options;
		this.restoreSkipped = options.skipRestore ?? false;
		// no snapshot capability: recovery is trivially "nothing to revive"
		if (!options.snapshot) this.settleRestore(null);
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
		// recovery is not on the first call's critical path: revive this kernel in the
		// first quiet gap (never ahead of a user cell) and settle restoreResult().
		this.maybeScheduleRestore();
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
				// --- a mid-session rebuild must revive the last snapshot BEFORE the cell that
				// --- triggered it (unlike a session-start boot, where recovery runs in the
				// --- background quiet gap and the first cell is served immediately). A wedged
				// --- revive kills the new kernel too; boot a fresh one — the restore is now
				// --- marked skipped, so the cell proceeds on live state instead of wedging. ---
				await this.restoreWithReap().catch(() => null);
				// read health through the getter: TS narrows this.kernel to undefined after the
				// assignment above, but start() may have replaced it with a live kernel
				if (!this.isRunning) {
					this.kernel = undefined;
					this.startPromise = undefined;
					await this.start();
				}
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

	/** Resolves with this engine's recovery outcome: the revived names, or null when there was
	 * nothing to restore, restore was skipped, or restore failed. Never rejects. The restore runs
	 * as a background quiet-gap job, so this promise is the ONLY hook the lifecycle needs to
	 * announce a resume or rebuild — acquire() never awaits it. */
	restoreResult(): Promise<RestoreResult | null> {
		if (this.restoreSettledResult !== undefined) return Promise.resolve(this.restoreSettledResult);
		if (!this.restorePromise) {
			this.restorePromise = new Promise<RestoreResult | null>((resolve) => {
				this.restoreResolve = resolve;
			});
		}
		return this.restorePromise;
	}

	/** True when restoring was deliberately skipped (a prior revive wedged or the engine was
	 * built with skipRestore). Lets the lifecycle say exactly why a revival did not happen. */
	restoreWasSkipped(): boolean {
		return this.restoreSkipped;
	}

	private settleRestore(result: RestoreResult | null): void {
		if (this.restoreSettledResult !== undefined) return;
		this.restoreSettledResult = result;
		this.restoreResolve?.(result);
		this.restoreResolve = undefined;
	}

	/** Arm the background revive for the freshly booted kernel. It fires in the first quiet gap
	 * (the same rule as the debounced snapshot: never ahead of a user cell) and settles
	 * restoreResult(). A fresh engine therefore serves its first cell without waiting for the
	 * restore, while a mid-session rebuild (execute's zombie path) forces it synchronously. */
	private maybeScheduleRestore(): void {
		const config = this.options.snapshot;
		if (!config) return;
		if (this.restoreSkipped) {
			this.settleRestore(null);
			return;
		}
		if (this.kernel && this.kernel === this.restoredKernel) return; // this kernel already revived
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return;
		}
		if (this.restoreTimer) return; // already armed
		const arm = () => {
			this.restoreTimer = setTimeout(() => {
				this.restoreTimer = undefined;
				// --- quiet-gap rule, mirroring scheduleSnapshot: a pickling restore must not
				// --- queue ahead of the user's next cell on the kernel's single queue ---
				if (this.inFlightCells > 0 || !this.kernel?.isRunning) {
					arm();
					return;
				}
				void this.runRestore();
			}, RESTORE_QUIET_MS);
			this.restoreTimer.unref?.();
		};
		arm();
	}

	/** Run the restore cell with a watchdog. A snapshot value whose unpickling never returns
	 * wedges the kernel's single queue forever; the reaper SIGKILLs the kernel and marks the
	 * restore skipped, so the next call rebuilds honestly ("wedged while reviving; skipped")
	 * instead of hanging every later cell behind the restore. */
	private async restoreWithReap(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config || !this.kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (this.kernel === this.restoredKernel) return this.restoreResult();
		const deadlineMs =
			Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? this.options.env?.PI_REPL_BOOT_TIMEOUT_MS ?? 0) ||
			DEFAULT_RESTORE_DEADLINE_MS;
		const reaper = setTimeout(() => {
			this.restoreSkipped = true;
			this.settleRestore(null);
			this.kernel?.kill();
		}, deadlineMs);
		reaper.unref?.();
		try {
			return await this.restoreState(false).catch(() => null);
		} finally {
			clearTimeout(reaper);
		}
	}

	private async runRestore(): Promise<void> {
		await this.restoreWithReap();
	}

	/** Revive this engine's kernel from the snapshot file. Idempotent per kernel: a second call
	 * shares the outcome of an in-flight restore instead of double-running the restore cell. */
	async restoreState(skip = false): Promise<RestoreResult | null> {
		// --- start unconditionally: direct callers may not have started the engine, and a
		// --- wedged boot is detectable only while a boot attempt is actually under way ---
		await this.start();
		if (skip) {
			this.settleRestore(null);
			return null;
		}
		const config = this.options.snapshot;
		const kernel = this.kernel;
		if (!config || !kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (kernel === this.restoredKernel) {
			// already revived or reviving on this kernel: share the outcome, never double-run
			return this.restoreResult();
		}
		// claim the kernel now so the quiet-gap scheduler cannot start a second restore cell
		this.restoredKernel = kernel;
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return null;
		}
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
			const reply = await kernel.restore(entries);
			const result: RestoreResult = { path: config.path, restored: reply.restored, failed: reply.failed };
			this.settleRestore(result);
			return result;
		} catch {
			this.settleRestore(null);
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
