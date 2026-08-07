/**
 * Engine lifecycle for a pi session: creation, revival, and the reset notice.
 *
 * Kept free of pi imports so the lifecycle is testable directly. The rule it
 * enforces is that **reviving the namespace is part of creating an engine**,
 * never a separate step a caller has to remember.
 *
 * That separation was a real defect. pi tears extensions down on reload
 * unconditionally, but only re-emits session_start when the extension has
 * registered UI, commands, a shutdown handler, or an error listener. An
 * extension with none of those got the teardown and not the startup, so the
 * next tool call quietly built a fresh engine with an empty namespace. Cells
 * kept working perfectly; every variable was simply gone.
 */

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

export function formatEngineResetNotice(restore: RestoreResult | null): string {
	const lines = ["<rlm_engine_reset>"];
	if (!restore) {
		lines.push(
			"The evaluator restarted and its namespace is empty; no snapshot was available to revive.",
			"Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else if (restore.restored.length === 0) {
		// A snapshot existed but nothing in it came back — saying "no snapshot"
		// here would send the model looking for the wrong cause.
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
	lines.push("Re-verify a variable before reusing it, especially inside shell interpolation.", "</rlm_engine_reset>");
	return lines.join("\n");
}

export class EngineLifecycle<E extends RevivableEngine> {
	private engine?: E;
	private revival?: Promise<RestoreResult | null>;
	private pendingNotice?: string;
	/** Teardown in progress; a rebuild must not overlap the final snapshot flush. */
	private teardown?: Promise<void>;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/**
	 * The live engine, built and revived if it does not exist yet.
	 *
	 * Revival is awaited here rather than left to a lifecycle event, so no
	 * caller can observe a namespace that was never given the chance to come
	 * back. An engine built to serve a cell also arms the reset notice.
	 */
	async acquire(origin: AcquireOrigin): Promise<{ engine: E; restore: RestoreResult | null; created: boolean }> {
		if (this.engine) {
			// Still awaited: a concurrent caller must not race ahead of revival.
			return { engine: this.engine, restore: await this.revival!, created: false };
		}
		// A teardown still flushing its final snapshot must finish before a new
		// engine reads that file, or the rebuild revives a half-written past.
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
