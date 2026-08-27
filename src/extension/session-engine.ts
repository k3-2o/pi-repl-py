// revival is part of create() so a session that gets teardown without a session_start reload still revives

import type { RestoreResult } from "../engine/index.js";

/** Show enough names to orient, then count the rest (a revive can carry hundreds). */
function summarizeNames(names: readonly string[], limit: number): string {
	if (names.length <= limit) return names.join(", ");
	return `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;
}

/** The part of EngineManager this lifecycle needs; narrowed so tests can fake it. */
export interface RevivableEngine {
	restoreState(): Promise<RestoreResult | null>;
	/** True when this conversation's state dir already exists, so the engine was resumed. */
	hasSnapshotHistory(): boolean;
}

export interface EngineLifecycleDeps<E extends RevivableEngine> {
	/** Builds a fresh engine. Called at most once per lifecycle generation. */
	create(): E;
	/** Tears the current engine down, flushing its final snapshot. */
	dispose(engine: E): Promise<void>;
	/** Kill-then-rebuild when a wedged engine cannot serve the snapshot flush. */
	discard?(engine: E): Promise<void>;
}

/** `startup` restores then announces on the first cell when the conversation has a saved past; `cell` means an engine was rebuilt mid-session and announces immediately. */
export type AcquireOrigin = "startup" | "cell";

// --- Terse TUI toast for the human, separate from the model-facing cell marker: the user
// --- asked for the classic subtle notification instead of a showy in-cell message. Counts
// --- come from the same restore the marker describes, so the two never disagree. ---
export function formatResetToast(origin: AcquireOrigin, restore: RestoreResult | null): string {
	const resumed = origin === "startup";
	const revived = restore?.restored.length ?? 0;
	const lost = restore?.failed.length ?? 0;
	if (restore && revived > 0) {
		const counts = lost > 0 ? `, ${lost} lost` : "";
		const noun = revived === 1 ? "name" : "names";
		return resumed
			? `repl session resumed, ${revived} ${noun} revived${counts}`
			: `repl kernel rebuilt, ${revived} ${noun} revived${counts}`;
	}
	return resumed
		? restore === null
			? "repl session resumed, nothing saved to revive"
			: "repl session resumed, nothing could be revived"
		: restore === null
			? "repl kernel rebuilt, nothing saved to revive"
			: "repl kernel rebuilt, nothing could be revived";
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
	private revival?: Promise<RestoreResult | null>;
	private pendingNotice?: string;
	private pendingReset?: { origin: AcquireOrigin; restore: RestoreResult | null };
	private teardown?: Promise<void>;
	/** First-build in progress. */
	private acquiring?: Promise<{ engine: E; restore: RestoreResult | null; created: boolean }>;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/** Built and revived on demand; awaited so callers never see an un-revived namespace. */
	async acquire(origin: AcquireOrigin): Promise<{ engine: E; restore: RestoreResult | null; created: boolean }> {
		if (this.engine) {
			return { engine: this.engine, restore: await this.revival!, created: false };
		}
		if (this.acquiring) return this.acquiring;
		const build = (async () => {
			while (this.teardown) await this.teardown;
			if (this.engine) {
				const held: E = this.engine;
				return { engine: held, restore: await this.revival!, created: false };
			}
			const engine = this.deps.create();
			this.engine = engine;
			this.revival = engine.restoreState().catch(() => null);
			const restore = await this.revival;
			// --- mid-session rebuilds always announce; startup announces only when the
			// --- conversation has a saved past, so a first-ever session stays quiet ---
			if (origin === "cell" || (origin === "startup" && engine.hasSnapshotHistory())) {
				this.pendingNotice = formatEngineResetNotice(restore, origin);
				this.pendingReset = { origin, restore };
			}
			return { engine, restore, created: true };
		})();
		this.acquiring = build;
		try {
			return await build;
		} finally {
			if (this.acquiring === build) this.acquiring = undefined;
		}
	}

	/** Returns the pending reset notice exactly once (alongside its origin and restore result), then clears it. */
	takeResetNotice(): { notice: string; origin: AcquireOrigin; restore: RestoreResult | null } | undefined {
		const reset = this.pendingReset;
		const notice = this.pendingNotice;
		this.pendingNotice = undefined;
		this.pendingReset = undefined;
		if (!notice || !reset) return undefined;
		return { notice, origin: reset.origin, restore: reset.restore };
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
		this.revival = undefined;
		this.pendingNotice = undefined;
		if (!engine) return;
		const teardown = run(engine).finally(() => {
			if (this.teardown === teardown) this.teardown = undefined;
		});
		this.teardown = teardown;
		await teardown;
	}
}
