/**
 * engine.integration.test.ts — the real host ↔ Python guest seam.
 *
 * Verifies the engine's auto-snapshot / restore round-trip against the real
 * `ipykernel` guest: a variable set in one engine survives into a freshly
 * spawned engine via the snapshot file (the "survive a restart" guarantee),
 * and that an aborted long cell does not wedge the next engine.
 *
 * These are the slow integration cases (each boots a real Python kernel); they
 * are kept separate from `units.test.ts` on purpose.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/engine/index.ts";

const tempDirs: string[] = [];
const engines: EngineManager[] = [];

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-repl-int-"));
	tempDirs.push(d);
	return d;
}

function engine(opts: Record<string, unknown>) {
	const m = new EngineManager(opts as never);
	engines.push(m);
	return m;
}

afterAll(async () => {
	await Promise.allSettled(engines.splice(0).map((m) => m.kill()));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("host × python-guest integration", () => {
	test("a variable set in one engine survives restart via the snapshot file", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		// set state in a real Python cell
		const r1 = await m1.execute("saved = {'a': 42, 'b': 'hello'}");
		expect(r1.status).toBe("ok");

		// wait for the debounced auto-snapshot to fire
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();

		// fresh engine over the same snapshot file → restore the state
		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("saved");

		// and the value is genuinely readable in the new kernel
		const r2 = await m2.execute("print(saved['a'], saved['b'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("42");
	});

	test("an aborted long cell does not wedge the next engine", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		// remember some state, then wait for its debounced snapshot to land
		const r0 = await m1.execute("notes = {'keep': True}");
		expect(r0.status).toBe("ok");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();

		// kick off a cell that runs past the snapshot, then abort it mid-flight
		const ac = new AbortController();
		const start = Date.now();
		const p1 = m1.execute("import time; time.sleep(60)", { signal: ac.signal });
		await new Promise((resolve) => setTimeout(resolve, 1200));
		ac.abort();
		const r1 = await p1;
		// the abort must be reported promptly, not after the 60s sleep finishes
		expect(r1.status).toBe("aborted");
		expect(Date.now() - start).toBeLessThan(10_000);

		// the host's recovery is discard→rebuild: a fresh engine over the same
		// snapshot must be responsive AND still hold the pre-abort state.
		await m1.kill();
		const m2 = engine({ cwd: d, snapshot: snap });
		const restore2 = await m2.restoreState();
		expect(restore2?.restored).toContain("notes");
		const r2 = await m2.execute("print('alive', notes['keep'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("alive");
		expect(r2.stdout).toContain("True");
	});
});
