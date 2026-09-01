// The lifecycle owns boot, session binding, and the reset announcements. Recovery is a
// background engine job (the quiet-gap restore): the first tool call waits only for the
// kernel to come up, and the reset notice lands on the first cell AFTER the restore lands.

import type { RestoreResult } from "../engine/index.js";

/** Show enough names to orient, then count the rest (a revive can carry hundreds). */
function summarizeNames(names: readonly string[], limit: number): string {
	if (names.length <= limit) return names.join(", ");
	return `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;
}

/** The part of EngineManager this lifecycle needs; narrowed so tests can fake it. */
export interface RevivableEngine {
	/** Boot the kernel (and preload helpers), independent of snapshot recovery. */
	start(skipRestore?: boolean): Promise<void>;
	/** Resolves once this engine's recovery has settled: revived names, or null when there was
	 * nothing to revive, recovery was skipped, or recovery failed. Never rejects. */
	restoreResult(): Promise<RestoreResult | null>;
	/** True when recovery was deliberately skipped (a prior revive wedged). */
	restoreWasSkipped(): boolean;
	/** True when this conversation's state dir already exists, so the engine was resumed. */
	hasSnapshotHistory(): boolean;
}

export interface EngineLifecycleDeps<E extends RevivableEngine> {
	/** Builds a fresh engine. Called at most once per lifecycle generation; `skipRestore` is
	 * true on the retry after a wedged boot, so the poisoned snapshot cannot wedge twice. */
	create(skipRestore?: boolean): E;
	/** Tears the current engine down, flushing its final snapshot. */
	dispose(engine: E): Promise<void>;
	/** Kill-then-rebuild when a wedged engine cannot serve the snapshot flush. */
	discard?(engine: E): Promise<void>;
	/** Boot deadline in ms; a boot (kernel start + helpers preload) that outlives it is killed
	 * and retried fresh. Default 90s. Recovery is NOT inside this deadline: it runs in the
	 * background and is bounded by the engine's own restore-cell watchdog. */
	bootTimeoutMs?: number;
}

/** `startup` restores then announces when the conversation has a saved past; `cell` means an engine was rebuilt mid-session and announces immediately. */
export type AcquireOrigin = "startup" | "cell";

const DEFAULT_BOOT_TIMEOUT_MS = 90_000;

/** Model-facing body for a boot whose snapshot revive wedged and was skipped. */
function revivedNoticeBody(origin: AcquireOrigin): string {
	const resumed = origin === "startup";
	return resumed
		? "This session's evaluator wedged while reviving the saved namespace, so the snapshot was skipped and the namespace is empty."
		: "The evaluator wedged while reviving its saved namespace, so the snapshot was skipped and the namespace is empty.";
}

// --- Terse TUI toast for the human, separate from the model-facing cell marker: the user
// --- asked for the classic subtle notification instead of a showy in-cell message. Counts
// --- come from the same restore the marker describes, so the two never disagree. ---
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

export class EngineLifecycle<E extends RevivableEngine> {
	private engine?: E;
	private pendingNotice?: string;
	private pendingReset?: { origin: AcquireOrigin; restore: RestoreResult | null; wedged: boolean };
	private teardown?: Promise<void>;
	/** First-build in progress. */
	private acquiring?: Promise<{ engine: E; restore: RestoreResult | null; created: boolean }>;
	/** The conversation this engine was built for; a different key on acquire tears it down. */
	private boundKey?: string;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/** Race one BOOT attempt (kernel start + helpers preload) against the deadline. Recovery is
	 * deliberately outside this race: it runs as a background quiet-gap job and is bounded by the
	 * engine's own restore-cell watchdog. A failed start is soft — the first cell observes it and
	 * the caller rebuilds. */
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

	/**
	 * Built and booted on demand; the snapshot restore proceeds in the background, so acquire()
	 * NEVER waits on it. The engine's revive is announced (reset notice + toast) on the first
	 * cell after it completes.
	 *
	 * `sessionKey` guards against sessions bleeding into each other: pi tears the old session
	 * down before starting the next, but a missed or out-of-order shutdown must never serve one
	 * conversation's engine and namespace to another — acquire for a different key tears the
	 * bound engine down (flushing its snapshot) before building the new one.
	 */
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
				// --- the kernel is alive but stuck; only a kill frees it. Retry once WITHOUT the
				// --- snapshot, so a poisoned snapshot cannot wedge the session twice in a row. ---
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
			// --- recovery is async and off the first call's critical path: the engine revives in
			// --- the first quiet gap and the notice lands on the first cell AFTER it completes
			// --- (index.ts takes it with takeResetNotice after the next execute). announce when
			// --- mid-session rebuilds happen, or on startup for a conversation with a saved past;
			// --- a first-ever session stays quiet. ---
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

	/** Returns the pending reset notice exactly once (alongside its origin, restore result, and
	 * whether the restore was skipped), then clears it. */
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
