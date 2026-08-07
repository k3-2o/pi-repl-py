/**
 * Engine lifecycle: revival is part of creating an engine.
 *
 * These pin the defect that lost a live session's namespace. pi tears
 * extensions down on reload unconditionally but only re-emits session_start
 * for extensions that registered UI, commands, a shutdown handler, or an error
 * listener. With revival wired only to session_start, an extension with none of
 * those got the teardown and not the startup: the next tool call built a fresh
 * engine with an empty namespace, and every cell after it worked perfectly
 * while every variable was gone.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager, type RestoreResult } from "../src/engine/index.js";
import {
	EngineLifecycle,
	formatEngineResetNotice,
	type RevivableEngine,
	summarizeNames,
} from "../src/extension/session-engine.js";

class FakeEngine implements RevivableEngine {
	restoreCalls = 0;
	disposed = false;
	constructor(private readonly result: RestoreResult | null) {}
	async restoreState(): Promise<RestoreResult | null> {
		this.restoreCalls++;
		return this.result;
	}
}

const snapshotWith = (restored: string[], failed: string[] = []): RestoreResult => ({
	path: "/tmp/snap",
	restored,
	failed: failed.map((name) => ({ name, reason: "not serializable" })),
});

function lifecycleOver(results: (RestoreResult | null)[]) {
	const built: FakeEngine[] = [];
	const lifecycle = new EngineLifecycle<FakeEngine>({
		create() {
			const engine = new FakeEngine(results[built.length] ?? null);
			built.push(engine);
			return engine;
		},
		async dispose(engine) {
			engine.disposed = true;
		},
	});
	return { lifecycle, built };
}

describe("engine lifecycle", () => {
	test("an engine built to serve a cell revives the namespace", async () => {
		// The regression: previously only the startup path revived, so an engine
		// created here began empty and nothing said so.
		const { lifecycle, built } = lifecycleOver([snapshotWith(["tmp", "entryPath"])]);
		const { restore, created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(built[0].restoreCalls).toBe(1);
		expect(restore?.restored).toEqual(["tmp", "entryPath"]);
	});

	test("a rebuild after shutdown revives again rather than starting empty", async () => {
		// This is the reload sequence exactly: teardown fires, no startup follows,
		// and the next cell is what brings the engine back.
		const { lifecycle, built } = lifecycleOver([snapshotWith(["a"]), snapshotWith(["a", "b"])]);
		await lifecycle.acquire("startup");
		await lifecycle.shutdown();
		expect(built[0].disposed).toBe(true);

		const { restore, created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(built).toHaveLength(2);
		expect(restore?.restored).toEqual(["a", "b"]);
	});

	test("the engine is created once and revived once, however many callers ask", async () => {
		const { lifecycle, built } = lifecycleOver([snapshotWith(["x"])]);
		const [first, second, third] = await Promise.all([
			lifecycle.acquire("cell"),
			lifecycle.acquire("cell"),
			lifecycle.acquire("cell"),
		]);
		expect(built).toHaveLength(1);
		expect(built[0].restoreCalls).toBe(1);
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(third.created).toBe(false);
		// Late callers still observe the revived state rather than racing past it.
		expect(second.restore?.restored).toEqual(["x"]);
	});

	test("a failing revival leaves a usable engine rather than propagating", async () => {
		const lifecycle = new EngineLifecycle({
			create: () => ({
				restoreState: async () => {
					throw new Error("snapshot unreadable");
				},
			}),
			dispose: async () => {},
		});
		const { restore } = await lifecycle.acquire("cell");
		expect(restore).toBeNull();
	});
});

describe("engine reset notice", () => {
	test("a cell-origin engine arms the notice; a startup one does not", async () => {
		const startup = lifecycleOver([snapshotWith(["a"])]);
		await startup.lifecycle.acquire("startup");
		// Startup is already announced in the transcript; a second notice is noise.
		expect(startup.lifecycle.takeResetNotice()).toBeUndefined();

		const midSession = lifecycleOver([snapshotWith(["a"])]);
		await midSession.lifecycle.acquire("cell");
		expect(midSession.lifecycle.takeResetNotice()).toContain("<rlm_engine_reset>");
	});

	test("the notice is delivered exactly once", async () => {
		const { lifecycle } = lifecycleOver([snapshotWith(["a"])]);
		await lifecycle.acquire("cell");
		expect(lifecycle.takeResetNotice()).toBeDefined();
		// The next cell must not be told again about a reset it already saw.
		expect(lifecycle.takeResetNotice()).toBeUndefined();
	});

	test("the notice names revived and lost variables", () => {
		const notice = formatEngineResetNotice(snapshotWith(["tmp", "entry"], ["edit", "readJson"]));
		expect(notice).toContain("Revived (2): tmp, entry");
		expect(notice).toContain("Lost (2): edit, readJson");
		expect(notice).toContain("</rlm_engine_reset>");
	});

	test("an empty namespace is stated plainly rather than as an empty list", () => {
		const notice = formatEngineResetNotice(null);
		expect(notice).toContain("namespace is empty");
		expect(notice).not.toContain("Revived (0)");
	});

	test("every notice warns about reuse in shell interpolation", () => {
		// The loss that motivated this surfaced as a stale variable interpolated
		// into a shell command, so the warning travels with the notice itself.
		for (const notice of [formatEngineResetNotice(null), formatEngineResetNotice(snapshotWith(["a"]))]) {
			expect(notice).toContain("shell interpolation");
		}
	});
});

describe("engine lifecycle over a real engine", () => {
	// The incident reproduced with real processes: an engine dies mid-session and
	// the next cell has to rebuild it. Nothing here calls a lifecycle event, which
	// is the point - that is precisely what pi skips on reload.
	test("a rebuilt engine revives the previous engine's namespace from disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-lifecycle-"));
		const snapshot = { path: join(dir, "namespace.snapshot") };
		const built: EngineManager[] = [];
		const lifecycle = new EngineLifecycle<EngineManager>({
			create() {
				const engine = new EngineManager({ snapshot });
				built.push(engine);
				return engine;
			},
			dispose: (engine) => engine.dispose(),
		});

		const first = (await lifecycle.acquire("startup")).engine;
		await first.execute('tmp = "/tmp/pi-rlm-pack-test"');
		await first.execute("keep = 7");
		// dispose flushes a final snapshot, standing in for pi's teardown.
		await lifecycle.shutdown();

		const { engine: second, restore, created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(built).toHaveLength(2);
		expect(restore?.restored).toContain("tmp");

		// The variable is genuinely usable in the new guest, not merely listed.
		const r = await second.execute("tmp");
		expect(r.result).toContain("/tmp/pi-rlm-pack-test");
		expect((await second.execute("keep")).result).toBe("7");

		const notice = lifecycle.takeResetNotice();
		expect(notice).toContain("<rlm_engine_reset>");
		expect(notice).toContain("tmp");
		await lifecycle.shutdown();
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);

	test("a rebuild with no snapshot says the namespace is empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-lifecycle-"));
		const lifecycle = new EngineLifecycle<EngineManager>({
			create: () => new EngineManager({ snapshot: { path: join(dir, "namespace.snapshot") } }),
			dispose: (engine) => engine.dispose(),
		});
		const { engine } = await lifecycle.acquire("cell");
		expect(await engine.execute("1 + 1")).toMatchObject({ status: "ok" });
		expect(lifecycle.takeResetNotice()).toContain("namespace is empty");
		await lifecycle.shutdown();
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);
});

describe("engine lifecycle hardening", () => {
	test("acquire during shutdown waits for the final snapshot flush", async () => {
		// A rebuild that overlaps a disposing engine's final flush revives a
		// half-written past. The rebuild must queue behind the teardown.
		const order: string[] = [];
		let releaseDispose: () => void = () => {};
		const lifecycle = new EngineLifecycle<FakeEngine>({
			create() {
				order.push("create");
				return new FakeEngine(snapshotWith(["a"]));
			},
			async dispose() {
				order.push("dispose:start");
				await new Promise<void>((resolve) => {
					releaseDispose = resolve;
				});
				order.push("dispose:end");
			},
		});
		await lifecycle.acquire("startup");
		order.length = 0;

		const closing = lifecycle.shutdown();
		const rebuilding = lifecycle.acquire("cell");
		await new Promise((r) => setTimeout(r, 20));
		expect(order).toEqual(["dispose:start"]);
		releaseDispose();
		await closing;
		await rebuilding;
		expect(order).toEqual(["dispose:start", "dispose:end", "create"]);
	});

	test("discard skips dispose and the next acquire rebuilds", async () => {
		// dispose would ask a wedged guest for a snapshot it can never serve;
		// discard must take the non-cooperative path.
		const calls: string[] = [];
		const lifecycle = new EngineLifecycle<FakeEngine>({
			create: () => new FakeEngine(snapshotWith(["a"])),
			dispose: async () => {
				calls.push("dispose");
			},
			discard: async () => {
				calls.push("discard");
			},
		});
		await lifecycle.acquire("startup");
		await lifecycle.discard();
		expect(calls).toEqual(["discard"]);
		const { created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(lifecycle.takeResetNotice()).toContain("<rlm_engine_reset>");
	});

	test("discard falls back to dispose when no discard dep is given", async () => {
		const calls: string[] = [];
		const lifecycle = new EngineLifecycle<FakeEngine>({
			create: () => new FakeEngine(null),
			dispose: async () => {
				calls.push("dispose");
			},
		});
		await lifecycle.acquire("startup");
		await lifecycle.discard();
		expect(calls).toEqual(["dispose"]);
	});

	test("a snapshot whose every entry failed is reported as such, not as missing", () => {
		// "No snapshot was available" would send the model looking for the wrong
		// cause when the snapshot existed and simply would not deserialize.
		const notice = formatEngineResetNotice(snapshotWith([], ["edit", "spawnSync"]));
		expect(notice).toContain("nothing in it could be revived");
		expect(notice).toContain("Failed to revive (2): edit, spawnSync");
		expect(notice).not.toContain("no snapshot was available");
	});
});

describe("name summaries", () => {
	test("short lists are shown whole", () => {
		expect(summarizeNames(["a", "b"], 8)).toBe("a, b");
	});

	test("long lists are capped with a count, not a wall", () => {
		const names = Array.from({ length: 434 }, (_, i) => `v${i}`);
		const summary = summarizeNames(names, 8);
		expect(summary).toBe("v0, v1, v2, v3, v4, v5, v6, v7 … and 426 more");
	});

	test("the reset notice caps its revived list", () => {
		const names = Array.from({ length: 100 }, (_, i) => `var${i}`);
		const notice = formatEngineResetNotice({ path: "/tmp/ns.snapshot", restored: names, failed: [] });
		expect(notice).toContain("… and 80 more");
		expect(notice.split("\n").length).toBeLessThan(10);
	});
});
