// Lifecycle: boot, session binding, reset announcements. Recovery is a background quiet-gap job; the notice lands on the first cell after the restore.

import type { HelperLoadResult, RestoreResult } from "../engine/index.js";

/** Show enough names to orient, then count the rest (a revive can carry hundreds). */
function summarizeNames(names: readonly string[], limit: number): string {
	if (names.length <= limit) return names.join(", ");
	return `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;
}

/** The part of EngineManager this lifecycle needs; narrowed so tests can fake it. */
export interface RevivableEngine {
	/** Boot the kernel (and preload helpers), independent of snapshot recovery. */
	start(skipRestore?: boolean): Promise<void>;
	/** Recovery outcome: revived names, or null when nothing to revive / skipped / failed. Never rejects. */
	restoreResult(): Promise<RestoreResult | null>;
	/** True when recovery was deliberately skipped (a prior revive wedged). */
	restoreWasSkipped(): boolean;
	/** True when this conversation's state dir already exists, so the engine was resumed. */
	hasSnapshotHistory(): boolean;
}

export interface EngineLifecycleDeps<E extends RevivableEngine> {
	/** Fresh engine; skipRestore is the retry after a wedged boot, so a poisoned snapshot can't wedge twice. */
	create(skipRestore?: boolean): E;
	/** Tears the current engine down, flushing its final snapshot. */
	dispose(engine: E): Promise<void>;
	/** Kill-then-rebuild when a wedged engine cannot serve the snapshot flush. */
	discard?(engine: E): Promise<void>;
	/** Boot deadline (default 90s): an overlong boot is killed and retried. Recovery is outside it — background, bounded by the restore-cell watchdog. */
	bootTimeoutMs?: number;
}

/** startup: announce when the conversation has a saved past; cell: a mid-session rebuild announces immediately. */
export type AcquireOrigin = "startup" | "cell";

const DEFAULT_BOOT_TIMEOUT_MS = 90_000;

function revivedNoticeBody(origin: AcquireOrigin): string {
	const resumed = origin === "startup";
	return resumed
		? "This session's evaluator wedged while reviving the saved namespace, so the snapshot was skipped and the namespace is empty."
		: "The evaluator wedged while reviving its saved namespace, so the snapshot was skipped and the namespace is empty.";
}

// --- human toast, separate from the model marker; counts come from the same restore, so the two never disagree ---
export function formatResetToast(origin: AcquireOrigin, restore: RestoreResult | null, wedged = false): string {
	const resumed = origin === "startup";
	const verb = resumed ? "repl session resumed" : "repl kernel rebuilt";
	if (wedged) return `${verb}, snapshot revive skipped (wedged)`;
	const revived = restore?.restored.length ?? 0;
	const lost = restore?.failed.length ?? 0;
	if (restore && revived > 0) {
		const counts = lost > 0 ? `, ${lost} lost` : "";
		const noun = revived === 1 ? "name" : "names";
		return `${verb}, ${revived} ${noun} revived${counts}`;
	}
	return restore === null ? `${verb}, nothing saved to revive` : `${verb}, nothing could be revived`;
}

function formatEngineResetNotice(restore: RestoreResult | null, origin: AcquireOrigin): string {
	const resumed = origin === "startup";
	const lines = ["<repl_engine_reset>"];
	if (!restore) {
		// --- no snapshot at all: namespace is genuinely empty ---
		lines.push(
			resumed
				? "This session's evaluator started fresh, and no saved snapshot was available to revive; the namespace is empty."
				: "The evaluator restarted and its namespace is empty; no snapshot was available to revive.",
			resumed
				? "Names from earlier in this conversation are gone. Rebuild what you need before using it."
				: "Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else if (restore.restored.length === 0) {
		// --- a snapshot existed but restored nothing; say why, don't claim "no snapshot" ---
		lines.push(
			resumed
				? "This session's evaluator started fresh. A saved snapshot was found, but nothing in it could be revived."
				: "The evaluator restarted and a snapshot was found, but nothing in it could be revived.",
			restore.failed.length > 0
				? `Failed to revive (${restore.failed.length}): ${summarizeNames(
						restore.failed.map((f) => f.name),
						20,
					)}`
				: "The snapshot was empty.",
			resumed
				? "Names from earlier in this conversation are gone. Rebuild what you need before using it."
				: "Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else {
		lines.push(
			resumed
				? "This session's evaluator started fresh and restored the namespace saved by this conversation's last run, so it may be empty or behind."
				: "The evaluator restarted. Its namespace was rebuilt from the last snapshot, so it may be behind.",
			`Revived (${restore.restored.length}): ${summarizeNames(restore.restored, 20)}`,
		);
		if (restore.failed.length > 0) {
			lines.push(
				`Lost (${restore.failed.length}): ${summarizeNames(
					restore.failed.map((f) => f.name),
					20,
				)}`,
				"Live handles, open resources, and source-less functions cannot be snapshotted; redefine them.",
			);
		}
		lines.push("Anything defined after the last snapshot is also gone.");
	}
	lines.push("Re-verify a variable before reusing it, especially inside shell interpolation.", "</repl_engine_reset>");
	return lines.join("\n");
}

/** Human toast when a /fork'd conversation inherited its parent's namespace — same counts as the reset marker, named as a fork so it can't pass for a plain resume. */
export function formatForkToast(restore: RestoreResult | null): string {
	const revived = restore?.restored.length ?? 0;
	if (revived > 0) {
		const noun = revived === 1 ? "name" : "names";
		return `repl fork started — ${revived} ${noun} inherited from the parent session`;
	}
	return restore === null
		? "repl fork started — nothing to inherit"
		: "repl fork started — parent snapshot revived nothing";
}

// --- split audience: toast for the human whenever a boot preloaded anything; a marker for the model ONLY when a helper failed (all-good boots are silent) ---

export function formatHelperToast(report: readonly HelperLoadResult[]): string {
	const loaded = report.filter((h) => h.ok).map((h) => h.name);
	const failed = report.filter((h) => !h.ok);
	const loadedPart = loaded.length > 0 ? `helpers loaded: ${loaded.join(", ")}` : "no helpers loaded";
	const failedPart =
		failed.length > 0 ? ` · failed: ${failed.map((f) => `${f.name} (${f.error ?? "failed to load"})`).join(", ")}` : "";
	return `repl ${loadedPart}${failedPart}`;
}

export function formatHelperFailuresLine(report: readonly HelperLoadResult[] | null): string | undefined {
	if (!report) return undefined;
	const failed = report.filter((h) => !h.ok);
	if (failed.length === 0) return undefined;
	return `<repl_helpers_failed: ${failed.map((f) => `${f.name} (${f.error ?? "failed to load"})`).join(", ")}>`;
}

export class EngineLifecycle<E extends RevivableEngine> {
	private engine?: E;
	private pendingNotice?: string;
	private pendingReset?: { origin: AcquireOrigin; restore: RestoreResult | null; wedged: boolean };
	private teardown?: Promise<void>;
	private acquiring?: Promise<{ engine: E; restore: RestoreResult | null; created: boolean }>;
	/** The conversation this engine was built for; a different key on acquire tears it down. */
	private boundKey?: string;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/** Race one boot (kernel start + helpers preload) against the deadline; a failed start is soft — the first cell observes it and rebuilds. */
	private bootOnce(engine: E, deadlineMs: number): Promise<boolean> {
		const work = Promise.resolve()
			.then(() => engine.start(false))
			.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const guard = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), deadlineMs);
			timer.unref?.();
		});
		return Promise.race([work.then(() => true), guard]).finally(() => clearTimeout(timer));
	}

	/** Built on demand; acquire() never waits on the background restore (announced on the first cell after it completes). sessionKey: a different conversation's acquire tears the bound engine down, so sessions can't bleed into each other. */
	async acquire(
		origin: AcquireOrigin,
		sessionKey?: string,
	): Promise<{ engine: E; restore: RestoreResult | null; created: boolean }> {
		if (sessionKey !== undefined && this.boundKey !== undefined && sessionKey !== this.boundKey) {
			await this.teardownWith((engine) => this.deps.dispose(engine));
		}
		if (this.engine) {
			return { engine: this.engine, restore: null, created: false };
		}
		if (this.acquiring) return this.acquiring;
		const build = (async () => {
			while (this.teardown) await this.teardown;
			if (this.engine) {
				const held: E = this.engine;
				return { engine: held, restore: null, created: false };
			}
			this.boundKey = sessionKey;
			const deadline = this.deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
			let engine = this.deps.create();
			this.engine = engine;
			let booted = await this.bootOnce(engine, deadline);
			if (!booted) {
				// --- the kernel is stuck, not dead; kill and retry once WITHOUT the snapshot so a poisoned one can't wedge twice ---
				await (this.deps.discard ?? this.deps.dispose)(engine);
				engine = this.deps.create(true);
				this.engine = engine;
				booted = await this.bootOnce(engine, deadline);
				if (!booted) {
					await (this.deps.discard ?? this.deps.dispose)(engine);
					this.engine = undefined;
					this.boundKey = undefined;
					throw new Error("evaluator boot timed out twice (kernel/helpers wedged); no session was started");
				}
			}
			// --- the notice lands on the first cell AFTER the restore completes; announce mid-session rebuilds and resumes with a saved past, never first sessions ---
			const announce = origin === "cell" || (origin === "startup" && engine.hasSnapshotHistory());
			void engine.restoreResult().then((restore) => {
				if (this.engine !== engine) return; // a replacement engine took over; no stale notice
				if (!announce) return;
				const wedged = engine.restoreWasSkipped();
				this.pendingNotice = wedged
					? [
							"<repl_engine_reset>",
							revivedNoticeBody(origin),
							"Re-verify a variable before reusing it, especially inside shell interpolation.",
							"</repl_engine_reset>",
						].join("\n")
					: formatEngineResetNotice(restore, origin);
				this.pendingReset = { origin, restore, wedged };
			});
			return { engine, restore: null, created: true };
		})();
		this.acquiring = build;
		try {
			return await build;
		} finally {
			if (this.acquiring === build) this.acquiring = undefined;
		}
	}

	/** The pending reset notice, taken exactly once. */
	takeResetNotice():
		| { notice: string; origin: AcquireOrigin; restore: RestoreResult | null; wedged: boolean }
		| undefined {
		const reset = this.pendingReset;
		const notice = this.pendingNotice;
		this.pendingNotice = undefined;
		this.pendingReset = undefined;
		if (!notice || !reset) return undefined;
		return { notice, origin: reset.origin, restore: reset.restore, wedged: reset.wedged };
	}

	async shutdown(): Promise<void> {
		await this.teardownWith((engine) => this.deps.dispose(engine));
	}

	/** Kill-then-rebuild for a wedged engine; skips the final snapshot flush, uses the last good one. */
	async discard(): Promise<void> {
		await this.teardownWith((engine) => (this.deps.discard ?? this.deps.dispose)(engine));
	}

	private async teardownWith(run: (engine: E) => Promise<void>): Promise<void> {
		const engine = this.engine;
		this.engine = undefined;
		this.boundKey = undefined;
		this.pendingNotice = undefined;
		if (!engine) return;
		const teardown = run(engine).finally(() => {
			if (this.teardown === teardown) this.teardown = undefined;
		});
		this.teardown = teardown;
		await teardown;
	}
}
