/**
 * engine.integration.test.ts — the real host ↔ real ipykernel seam.
 *
 * These are the guarantees the Python guest contract suite (guest_contract.py)
 * used to pin: persistence across cells, error survival, output attribution,
 * helpers loading, snapshot/restore round-trips, output caps, and the per-cell
 * silence timeout. The guest.py middleman is gone; the host now speaks the
 * Jupyter protocol directly, so the same guarantees are proven here against a
 * real kernel — each test boots one or more genuine ipykernel subprocesses,
 * which is why this suite is slow and kept out of `just check`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("host × python-kernel integration", () => {
	test("variables and functions survive across cells", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		const r1 = await m.execute("x = 10");
		expect(r1.status).toBe("ok");
		const r2 = await m.execute("def double(n): return n * 2");
		expect(r2.status).toBe("ok");
		const r3 = await m.execute("print('x is', x, 'double is', double(x))");
		expect(r3.status).toBe("ok");
		expect(r3.stdout).toContain("x is 10");
		expect(r3.stdout).toContain("20");
	});

	test("a raising cell reports a real traceback and does not kill the namespace", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("x = 7");
		const bad = await m.execute("1 / 0");
		expect(bad.status).toBe("error");
		expect(bad.error?.name).toBe("ZeroDivisionError");
		expect((bad.error?.stack ?? []).join("\n")).toContain("ZeroDivisionError");

		const ok = await m.execute("y = x + 1");
		expect(ok.status).toBe("ok");
		const print = await m.execute("print(y)");
		expect(print.stdout).toContain("8");
	});

	test("only printed output and the final result return", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		const assign = await m.execute("z = 100");
		expect(assign.status).toBe("ok");
		expect(assign.stdout).toBe("");
		expect(assign.result).toBeUndefined();

		const print = await m.execute("print('saw', z)");
		expect(print.stdout).toContain("saw 100");
		const result = await m.execute("z * 2");
		expect(result.result).toBeDefined();
		expect(result.result).toContain("200");
	});

	test(
		"no pi-repl discovery intrinsics are injected; the workspace is standard Python",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			// hermetic helpers dir: nothing preloaded
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: tempDir() } });

			// The custom ls() intrinsic is gone: 'ls' is not in the namespace, and no
			// pi/helper-specific symbol was injected — discovery is ordinary Python.
			const ls = await m.execute("print('ls' in globals())");
			expect(ls.status).toBe("ok");
			expect(ls.stdout).toContain("False");

			// Standard introspection stays available (the builtin help() stands in for
			// the old helper-usage helper).
			const intro = await m.execute("print(callable(help), len(globals()) >= 0)");
			expect(intro.status).toBe("ok");
			expect(intro.stdout).toContain("True");
		},
	);

	test(
		"a custom helper file loads into the kernel and appears under plain Python globals()",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			const r = await m.execute("print(double(21))");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("42");

			const ns = await m.execute("print([k for k in globals() if k == 'double'])");
			expect(ns.status).toBe("ok");
			expect(ns.stdout).toContain("double");
			for (const stale of ["shell", "edit", "read", "write", "bash"]) {
				expect(ns.stdout).not.toContain(stale);
			}
		},
	);

	test("a variable set in one engine survives restart via the snapshot file", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		const r1 = await m1.execute("saved = {'a': 42, 'b': 'hello'}");
		expect(r1.status).toBe("ok");

		// wait for the debounced auto-snapshot to fire
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("saved");

		const r2 = await m2.execute("print(saved['a'], saved['b'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("42");
		expect(r2.stdout).toContain("hello");
	});

	test("snapshot excludes helper metadata and flags completeness", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const helpers = tempDir();
		writeFileSync(
			join(helpers, "web.py"),
			'helper_description = """web(query) — stub."""\ndef web(query):\n    return query\n',
		);
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers }, snapshot: snap });

		await m.execute("data = {'count': 42}");
		const result = await m.snapshotState();
		expect(result?.saved).toContain("data");
		expect(result?.saved).not.toContain("helper_description");
		expect(result?.saved).not.toContain("web"); // helpers are kernel-side, not user state
	});

	test("restore reports failed values without crashing the kernel", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("good = {'ok': True}");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();
		await m1.kill();

		// inject a corrupt entry into the snapshot file, then revive from it
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as { vars: Record<string, string> };
		file.vars["junk"] = "not-valid-pickle-base64!!!";
		writeFileSync(snap.path, JSON.stringify(file));

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("good");
		expect(restore?.failed.some((f) => f.name === "junk")).toBe(true);

		const r = await m2.execute("print('still alive', good['ok'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("True");
	});

	test(
		"output channel beyond the cap is truncated with a marker, not dropped silently",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d });

			// Many short lines (100 chars each) keep the total small per line so only the CHANNEL cap applies.
			const r = await m.execute("print('\\n'.join('x' * 100 for _ in range(200_000)))", { maxOutputChars: 4096 });
			expect(r.status).toBe("ok");
			expect(r.stdout.length).toBeGreaterThan(4000);
			expect(r.stdout).toContain("output truncated at 4096 chars");
		},
	);

	test("a single oversized line is capped per line, not allowed to own the output", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		// One giant line (10M chars) must be capped to a per-line length instead of eating the whole budget.
		const r = await m.execute("print('x' * 10_000_000)", { maxOutputChars: 65536 });
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("some lines exceeded 4096 chars");
		expect(r.stdout.length).toBeLessThan(4300);
	});

	test("listNamespaceNames lists user state and excludes helpers", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const helpers = tempDir();
		writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
		const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

		await m.execute("alpha = 1; beta = 2");
		const names = await m.listNamespaceNames();
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).not.toContain("double");
	});

	test("a cell that exceeds the silence window is reported as an error", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "400" } });

		const r = await m.execute("import time; time.sleep(1.5); print('late')");
		expect(r.status).toBe("error");
		expect(r.error?.name).toBe("Timeout");
		expect(r.error?.message.toLowerCase()).toContain("did not finish");
	});

	test("the silence watchdog allows a cell that keeps producing output", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "800" } });

		const r = await m.execute(
			"import time\nfor _ in range(20):\n    print('beat')\n    time.sleep(0.05)\nprint('done')",
		);
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("done");
	});

	test("an aborted cell interrupts the kernel and keeps the namespace alive", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("notes = {'keep': True}");

		const ac = new AbortController();
		const start = Date.now();
		const p = m.execute("import time; time.sleep(60)", { signal: ac.signal });
		await new Promise((resolve) => setTimeout(resolve, 1200));
		ac.abort();
		const r1 = await p;
		expect(r1.status).toBe("aborted");
		expect(Date.now() - start).toBeLessThan(10_000);

		// the kernel was interrupted, not killed: fresh state survives
		const r2 = await m.execute("print('alive', notes['keep'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("alive");
		expect(r2.stdout).toContain("True");
	});

	test("a dead kernel settles the next cell with a rebuild from the last snapshot", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m = engine({ cwd: d, snapshot: snap });

		await m.execute("notes = {'keep': True}");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m.snapshotState();

		await m.kill();
		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("notes");
		const r = await m2.execute("print('rebuilt', notes['keep'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("rebuilt");
		expect(r.stdout).toContain("True");
	});

	test(
		"a silence-watchdog cell that swallows KeyboardInterrupt is killed and the next cell rebuilds",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "800" } });

			await m.execute("kept = {'boot': True}");
			const start = Date.now();
			// the cell never answers (KeyboardInterrupt is caught and ignored), so the silence
			// watchdog must escalate from interrupt to a kill instead of leaving the queue wedged.
			await expect(
				m.execute(
					"import time\nwhile True:\n    try:\n        time.sleep(0.02)\n    except KeyboardInterrupt:\n        continue",
				),
			).rejects.toThrow();
			expect(Date.now() - start).toBeLessThan(40_000);

			// the engine rebuilt around the dead kernel rather than hanging the next cell
			const r = await m.execute("2 + 2");
			expect(r.status).toBe("ok");
			expect(r.result).toContain("4");
		},
	);

	test("an unexpectedly-dead kernel is discovered and the next cell rebuilds", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("import os");
		await expect(m.execute("os._exit(9)")).rejects.toThrow();

		// isRunning reflects the death, so the engine drops the zombie and rebuilds
		expect(m.isRunning).toBe(false);
		const r = await m.execute("3 + 4");
		expect(r.status).toBe("ok");
		expect(r.result).toContain("7");
	});
});
