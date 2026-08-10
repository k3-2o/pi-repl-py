// A session may get teardown without session_start on reload, so revival is part of create() (was a real defect)

import type { RestoreResult } from "../engine/index.js";

/**
 * A revived session can carry hundreds of variables; listing them all turns
 * the banner and the reset notice into a wall. Show enough to orient, then
 * count the rest.
 */
export function summarizeNames(names: readonly string[], limit: number): string {
	if (names.length <= limit) return names.join(", ");
	return `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;
}

/** The part of EngineManager this lifecycle needs; narrowed so tests can fake it. */
export interface RevivableEngine {
	restoreState(): Promise<RestoreResult | null>;
}

export interface EngineLifecycleDeps<E extends RevivableEngine> {
	/** Builds a fresh engine. Called at most once per lifecycle generation. */
	create(): E;
	/** Tears the current engine down, flushing its final snapshot. */
	dispose(engine: E): Promise<void>;
	/**
	 * Tears down an engine that cannot cooperate — a wedged guest cannot serve
	 * the snapshot flush dispose would ask of it. Falls back to dispose.
	 */
	discard?(engine: E): Promise<void>;
}

/**
 * Why an engine came into existence. `startup` is the expected path and is
 * already announced in the transcript; `cell` means an engine had to be built
 * to serve a tool call, which only happens when the previous one went away
 * mid-session — the case the model needs told about in-band.
 */
export type AcquireOrigin = "startup" | "cell";

function formatEngineResetNotice(restore: RestoreResult | null): string {
	const lines = ["<repl_engine_reset>"];
	if (!restore) {
		// --- no snapshot at all: namespace is genuinely empty ---
		lines.push(
			"The evaluator restarted and its namespace is empty; no snapshot was available to revive.",
			"Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else if (restore.restored.length === 0) {
		// --- a snapshot existed but restored nothing; say why, don't claim "no snapshot" ---
		lines.push(
			"The evaluator restarted and a snapshot was found, but nothing in it could be revived.",
			restore.failed.length > 0
				? `Failed to revive (${restore.failed.length}): ${summarizeNames(
						restore.failed.map((f) => f.name),
						20,
					)}`
				: "The snapshot was empty.",
			"Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else {
		lines.push(
			"The evaluator restarted. Its namespace was rebuilt from the last snapshot, so it may be behind.",
			`Revived (${restore.restored.length}): ${summarizeNames(restore.restored, 20)}`,
		);
		if (restore.failed.length > 0) {
			lines.push(
				`Lost (${restore.failed.length}): ${summarizeNames(
					restore.failed.map((f) => f.name),
					20,
				)}`,
				"Functions, classes, and live handles cannot be snapshotted; redefine them.",
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
	/** Teardown in progress; a rebuild must not overlap the final snapshot flush. */
	private teardown?: Promise<void>;
	/** First-build in progress: concurrent acquire() must not spawn two engines. */
	private acquiring?: Promise<{ engine: E; restore: RestoreResult | null; created: boolean }>;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/**
	 * The live engine, built and revived if it does not exist yet.
	 * Revival is awaited here so a caller never sees an un-revived namespace.
	 */
	async acquire(origin: AcquireOrigin): Promise<{ engine: E; restore: RestoreResult | null; created: boolean }> {
		if (this.engine) {
			return { engine: this.engine, restore: await this.revival!, created: false };
		}
		// --- two concurrent acquires on an empty engine must share one build ---
		if (this.acquiring) return this.acquiring;
		const build = (async () => {
			// --- a teardown flushing its final snapshot must finish before the rebuild reads it ---
			while (this.teardown) await this.teardown;
			if (this.engine) {
				const held: E = this.engine;
				return { engine: held, restore: await this.revival!, created: false };
			}
			const engine = this.deps.create();
			this.engine = engine;
			this.revival = engine.restoreState().catch(() => null);
			const restore = await this.revival;
			if (origin === "cell") this.pendingNotice = formatEngineResetNotice(restore);
			return { engine, restore, created: true };
		})();
		this.acquiring = build;
		try {
			return await build;
		} finally {
			if (this.acquiring === build) this.acquiring = undefined;
		}
	}

	/** Returns the pending reset notice exactly once, then clears it. */
	takeResetNotice(): string | undefined {
		const notice = this.pendingNotice;
		this.pendingNotice = undefined;
		return notice;
	}

	async shutdown(): Promise<void> {
		await this.teardownWith((engine) => this.deps.dispose(engine));
	}

	/**
	 * Teardown for an engine that cannot cooperate (e.g. wedged in synchronous
	 * code). Skips the snapshot flush a graceful dispose would attempt; the next
	 * acquire builds a fresh engine revived from the last completed snapshot.
	 */
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
