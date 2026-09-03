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
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { EngineManager } from "../src/engine/index.ts";
import { EngineLifecycle, formatForkToast } from "../src/extension/session-engine.ts";
import { inheritForkSnapshot, resolveStateDir } from "../src/extension/state-layout.ts";

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

// --- kernels must not outlive their test: the watchdog assertions are timing-sensitive,
// --- and a pile of idle ipykernel processes from earlier tests starves the CPU enough to
// --- push inter-beat gaps past the silence window, flaking "output keeps the watchdog fed"
// --- into a false kill. Each test therefore runs against a quiet machine; afterAll remains
// --- only as a safety net for engines created outside a test body. ---
afterEach(async () => {
	await Promise.allSettled(engines.splice(0).map((m) => m.kill().catch(() => {})));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

	test(
		"a deleted session cwd does not prevent the kernel from booting (cwd fallback)",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d });
			// the resume case the fallback exists for: the project dir is gone by boot time
			rmSync(d, { recursive: true, force: true });
			const r = await m.execute(`import os
print(os.getcwd() != ${JSON.stringify(d)})`);
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("True");
		},
	);

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

	test("a project helper shadows the same-named global helper inside the kernel", { timeout: 60_000 }, async () => {
		// project .pi/helpers/web.py wins over global web.py — by VALUE in the live kernel,
		// proving the prompt list and the preload agree on the merged set.
		const global = tempDir();
		writeFileSync(join(global, "web.py"), "def web():\n    return 'GLOBAL'\n");
		const proj = tempDir();
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "web.py"), "def web():\n    return 'PROJECT'\n");

		const m = engine({ cwd: proj, env: { PI_HELPERS_GLOBAL_DIR: global } });
		const r = await m.execute("print(web())");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("PROJECT");
		expect(r.stdout).not.toContain("GLOBAL");
	});

	test("global helpers still load when the project has none, from a deep cwd", { timeout: 60_000 }, async () => {
		const global = tempDir();
		writeFileSync(join(global, "grid.py"), "def grid():\n    return 'G'\n");
		const proj = tempDir();
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "core.py"), "def core():\n    return 'C'\n");
		// deep cwd WITHOUT a local .pi/helpers: project helper at root + global helper both reach the kernel
		const deep = join(proj, "src", "tools");
		mkdirSync(deep, { recursive: true });

		const m = engine({ cwd: deep, env: { PI_HELPERS_GLOBAL_DIR: global } });
		const r = await m.execute("print(core(), grid())");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("C G");
	});

	test(
		"a broken helper fails alone: the others still load, and the boot report names it",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "scraper.py"), "def scraper(\n"); // SyntaxError
			writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			const r = await m.execute("print('has double:', 'double' in globals())");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("has double: True"); // the sibling helper survived

			const report = m.takeHelperReport();
			expect(report).not.toBeNull();
			expect(report!.length).toBe(2); // alphabetical: double loads, scraper fails
			const double = report!.find((h) => h.name === "double");
			const scraper = report!.find((h) => h.name === "scraper");
			expect(double?.ok).toBe(true);
			expect(scraper?.ok).toBe(false);
			expect(scraper?.error).toContain("SyntaxError");

			// the report is handed out exactly once per boot
			expect(m.takeHelperReport()).toBeNull();
		},
	);

	test(
		"an all-good boot reports every helper loaded and stays quiet on the second take",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "web.py"), "def web():\n    return 'W'\n");
			writeFileSync(join(helpers, "core.py"), "def core():\n    return 'C'\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			await m.execute("1 + 1"); // settle the boot, then take the report
			const report = m.takeHelperReport();
			expect(report).not.toBeNull();
			expect(report!.filter((h) => h.ok).map((h) => h.name)).toEqual(["core", "web"]);
			expect(report!.some((h) => !h.ok)).toBe(false);
			expect(m.takeHelperReport()).toBeNull();
		},
	);

	test(
		"a fresh engine serves the first cell before the quiet-gap restore; the restore then lands",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m1 = engine({ cwd: d, snapshot: snap });
			await m1.execute("saved = {'a': 42, 'big': list(range(200_000))}");
			await m1.snapshotState();
			await m1.kill();

			const m2 = engine({ cwd: d, snapshot: snap });
			// recovery is a background quiet-gap job: the first cell is served on the freshly
			// booted kernel and must NOT wait for the restore (the restore is armed only to fire
			// when the kernel is idle, so it can never be ahead of this cell)
			const first = await m2.execute("print('early', 'saved' in globals())");
			expect(first.status).toBe("ok");
			expect(first.stdout).toContain("early");
			expect(first.stdout).toContain("False"); // not revived yet — and the cell didn't block on it

			// the restore lands in the quiet gap and the name goes live
			const deadline = Date.now() + 30_000;
			let seen = false;
			while (Date.now() < deadline && !seen) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const r = await m2.execute("print('saved' in globals())");
				seen = r.stdout.includes("True");
			}
			expect(seen).toBe(true);
			const check = await m2.execute("print(saved['a'])");
			expect(check.status).toBe("ok");
			expect(check.stdout).toContain("42");
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

	test(
		"bindings skipped at save time are named in the resume result, not dropped silently",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			// tiny caps: the huge binding exceeds the per-entry cap and is skipped AT SAVE time
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200, maxBytes: 1000 };
			const m1 = engine({ cwd: d, snapshot: snap });

			const r1 = await m1.execute("import os\nhuge = os.urandom(5000)\nkept = {'k': 1}");
			expect(r1.status).toBe("ok");
			const saved = await m1.snapshotState();
			expect(saved?.saved).toContain("kept");
			expect(saved?.failed.find((f) => f.name === "huge")?.reason).toContain("cap");

			const m2 = engine({ cwd: d, snapshot: snap });
			const restore = await m2.restoreState();
			expect(restore?.restored).toContain("kept");
			// the save-time skip surfaces in the restore result (and thus the resume notice),
			// which previously only named failures that happened again during restore
			expect(restore?.failed.some((f) => f.name === "huge")).toBe(true);
			const r2 = await m2.execute("print('huge' in globals(), kept['k'])");
			expect(r2.status).toBe("ok");
			expect(r2.stdout).toContain("False");
			expect(r2.stdout).toContain("1");
		},
	);

	test("same-name mutations survive a crash via the periodic refresh", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 50, periodMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		const r1 = await m1.execute("data = {'k': 1}");
		expect(r1.status).toBe("ok");
		// name-change snapshot lands
		await new Promise((resolve) => setTimeout(resolve, 500));

		// in-place mutation: names unchanged, so only the staleness clock can re-arm
		const r2 = await m1.execute("data['k'] = 42");
		expect(r2.status).toBe("ok");
		// the period elapses; the first cell after it sees the stale clock and refreshes
		await new Promise((resolve) => setTimeout(resolve, 700));
		const r3 = await m1.execute("1 + 1");
		expect(r3.status).toBe("ok");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await m1.kill(); // crash path: no dispose flush — only the forced refresh can save it

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("data");
		const r4 = await m2.execute("print(data['k'])");
		expect(r4.status).toBe("ok");
		expect(r4.stdout).toContain("42");
	});

	test("snapshot files are version 3 with zlib-compressed value payloads", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("payload_v = {'a': 1}");
		await m1.snapshotState();
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			version: number;
			entries: { name: string; kind: string; payload: string }[];
		};
		expect(file.version).toBe(3);
		const entry = file.entries.find((e) => e.name === "payload_v");
		expect(entry).toBeDefined();
		// the payload must be a zlib stream (a raw pickle would fail to decompress)
		expect(inflateSync(Buffer.from(entry!.payload, "base64")).length).toBeGreaterThan(0);
	});

	test("a version 2 snapshot file (plain pickles) still restores", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("legacy = {'v': 7}");
		await m1.snapshotState();
		// downgrade the file to the pre-compression format: unwrap each value payload to the raw pickle
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			version: number;
			entries: { name: string; kind: string; payload: string }[];
			failed: unknown[];
		};
		expect(file.version).toBe(3);
		for (const e of file.entries) {
			if (e.kind === "value") {
				const raw = inflateSync(Buffer.from(e.payload, "base64"));
				e.payload = Buffer.from(raw).toString("base64");
			}
		}
		file.version = 2;
		writeFileSync(snap.path, JSON.stringify(file));

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("legacy");
		const r = await m2.execute("print(legacy['v'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("7");
	});

	test("a /fork'd conversation inherits the parent's namespace and restores it", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-int-"));
		tempDirs.push(sessionsRoot);
		const slugDir = join(sessionsRoot, "proj-a");
		mkdirSync(slugDir, { recursive: true });
		const parentFile = join(slugDir, "parent.jsonl");
		const forkFile = join(slugDir, "forked.jsonl");
		const stateRoot = join(d, "state");

		// parent session: real engine, real snapshot
		const parentSnap = resolveStateDir(stateRoot, parentFile).snapshotPath;
		const m1 = engine({ cwd: d, snapshot: { path: parentSnap, debounceMs: 200 } });
		await m1.execute("inherited = {'fork': 'yes', 'n': 42}");
		await m1.snapshotState();
		await m1.kill();

		// the fork: pi-style header naming the parent, then the inherit pass
		writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
		writeFileSync(forkFile, JSON.stringify({ type: "session", version: 3, id: "forked", parentSession: parentFile }));
		const forkSnap = resolveStateDir(stateRoot, forkFile).snapshotPath;
		expect(existsSync(forkSnap)).toBe(false);
		inheritForkSnapshot(stateRoot, forkFile, forkSnap);

		// the fork's engine restores like any resume: same revive, same notice path
		const m2 = engine({ cwd: d, snapshot: { path: forkSnap, debounceMs: 200 } });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("inherited");
		const r = await m2.execute("print(inherited['fork'], inherited['n'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("yes");
		expect(r.stdout).toContain("42");
	});

	test(
		"a /fork'd conversation carries the reset marker on its first cell, like any resume",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-lc-"));
			tempDirs.push(sessionsRoot);
			const slugDir = join(sessionsRoot, "proj-a");
			mkdirSync(slugDir, { recursive: true });
			const parentFile = join(slugDir, "parent.jsonl");
			const forkFile = join(slugDir, "forked.jsonl");
			const stateRoot = join(d, "state");

			const parentSnap = resolveStateDir(stateRoot, parentFile).snapshotPath;
			const m1 = engine({ cwd: d, snapshot: { path: parentSnap, debounceMs: 200 } });
			await m1.execute("forked_data = {'from': 'parent'}");
			await m1.snapshotState();
			await m1.kill();

			writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
			writeFileSync(forkFile, JSON.stringify({ type: "session", version: 3, id: "forked", parentSession: parentFile }));
			const forkSnap = resolveStateDir(stateRoot, forkFile).snapshotPath;
			expect(inheritForkSnapshot(stateRoot, forkFile, forkSnap)).toBe(true);

			// the lifecycle path, exactly as index.ts drives it
			const lifecycle = new EngineLifecycle<EngineManager>({
				create: () => new EngineManager({ cwd: d, snapshot: { path: forkSnap, debounceMs: 100 }, forkInherited: true }),
				dispose: async (e) => e.kill(),
			});
			const { engine: m2 } = await lifecycle.acquire("startup", "fork-conv");

			// the restore lands in the quiet gap and the marker follows it
			const deadline = Date.now() + 30_000;
			let revived = false;
			while (Date.now() < deadline && !revived) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const r = await m2.execute("print('forked_data' in globals())");
				revived = r.stdout.includes("True");
			}
			expect(revived).toBe(true);
			expect(m2.inheritedFromFork).toBe(true);

			const reset = lifecycle.takeResetNotice();
			expect(reset?.notice).toContain("<repl_engine_reset>");
			expect(reset?.notice).toContain("forked_data");
			expect(formatForkToast(reset?.restore ?? null)).toContain("fork started");
			expect(formatForkToast(reset?.restore ?? null)).toContain("1 name inherited");

			await lifecycle.shutdown();
		},
	);

	test(
		"a snapshot whose revive wedges is skipped in the background and the session still starts",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m1 = engine({ cwd: d, snapshot: snap });
			// __setstate__ sleeps forever, so unpickling this value during restore wedges the kernel
			const r1 = await m1.execute(
				"class W:\n    def __setstate__(self, state):\n        import time\n        time.sleep(60)\n    def __init__(self):\n        self.x = 1\nw = W()",
			);
			expect(r1.status).toBe("ok");
			await new Promise((resolve) => setTimeout(resolve, 800));
			await m1.snapshotState();

			// the boot deadline bounds kernel start + helpers preload; the restore cell has its own
			// engine-level watchdog (same env var), and the lifecycle skips reviving after the boot
			// deadline trips. Both get a short deadline so the wedge is detected fast.
			const lc = new EngineLifecycle<EngineManager>({
				create: (skip) =>
					engine({ cwd: d, snapshot: snap, skipRestore: skip, env: { PI_REPL_BOOT_TIMEOUT_MS: "3000" } }),
				async dispose(m) {
					await m.dispose();
				},
				async discard(m) {
					await m.kill();
				},
				bootTimeoutMs: 8_000,
			});
			const started = Date.now();
			const { engine: m2, restore } = await lc.acquire("cell");
			// recovery is async: acquire returns after BOOT, not after the wedged restore settles
			expect(Date.now() - started).toBeLessThan(15_000);
			expect(restore).toBe(null);

			// the poisoned revive is detected in the background: the reaper kills the wedged kernel
			// and the engine marks the restore skipped; the announcement follows once that settles
			const noticeDeadline = Date.now() + 30_000;
			let notice: ReturnType<typeof lc.takeResetNotice> | undefined;
			while (Date.now() < noticeDeadline && !notice) {
				notice = lc.takeResetNotice();
				if (!notice) await new Promise((resolve) => setTimeout(resolve, 200));
			}
			expect(notice?.notice).toContain("wedged");
			expect(notice?.notice).toContain("skipped");
			expect(notice?.restore).toBe(null);
			expect(notice?.wedged).toBe(true);

			// the replacement kernel serves cells and never re-touches the poisoned snapshot
			const r2 = await m2.execute("2 + 2");
			expect(r2.status).toBe("ok");
			expect(r2.result).toContain("4");
			// the wedge was skipped once, not retried: the namespace stays empty but alive
			const r3 = await m2.execute("print('w' in globals())");
			expect(r3.status).toBe("ok");
			expect(r3.stdout).toContain("False");
		},
	);

	test("a cell-defined function and class survive restart via source capture", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		const r1 = await m1.execute(
			"def greet(name):\n    return f'hi {name}'\nclass Box:\n    def __init__(self, v):\n        self.v = v\nitem = 41",
		);
		expect(r1.status).toBe("ok");
		await m1.snapshotState();
		await m1.kill();
		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("greet");
		expect(restore?.restored).toContain("Box");
		expect(restore?.restored).toContain("item");
		const r2 = await m2.execute("print(greet('tester'))");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("hi tester");
		const r3 = await m2.execute("print(Box(7).v)");
		expect(r3.stdout).toContain("7");
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

	test("a pending snapshot never lands in front of a queued user cell", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 150 };
		const m = engine({ cwd: d, snapshot: snap });

		await m.execute("x = 1");
		// A name change arms the debounced snapshot; the pickle is heavy (seconds
		// for a multi-million-element namespace), so queue position decides latency.
		await m.execute("big = list(range(3_000_000))");

		// The debounce expires inside these cells. The snapshot must wait for a
		// quiet gap instead of pickling ahead of the trivial third cell.
		const r2 = await m.execute("import time; time.sleep(0.3); print('mid')");
		const start = Date.now();
		const r3 = await m.execute("print('here')");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("mid");
		expect(r3.status).toBe("ok");
		expect(r3.stdout).toContain("here");
		// Old behaviour left the trivial cell waiting behind a ~2s pickle.
		expect(Date.now() - start).toBeLessThan(1_000);

		// Once the kernel goes quiet the snapshot still lands.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(existsSync(snap.path)).toBe(true);
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
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			entries: { name: string; kind: "value" | "def"; payload: string }[];
		};
		file.entries.push({ name: "junk", kind: "value", payload: "not-valid-pickle-base64!!!" });
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
		// --- 25ms beats against a 1.6s window (64x margin): the cell outlives the window, so a
		// --- watchdog that ignored output would still kill it, but a transient host stall would
		// --- have to exceed 1.5s to falsely kill a healthy cell. The kill path itself is pinned
		// --- by the exceeds-window test above; this is the positive control. ---
		const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "1600" } });

		const r = await m.execute(
			"import time\nfor _ in range(80):\n    print('beat')\n    time.sleep(0.025)\nprint('done')",
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

	test("cells run with history off so results cannot accumulate", { timeout: 60_000 }, async () => {
		// --- store_history is deliberately false on every execute (see executeRequest in
		// --- session.ts): IPython retains each result object in In/Out, and that retention is
		// --- NOT reclaimable from user cells — deleting Out and _/__/___ from user_ns and
		// --- gc.collect() leaves the objects alive (measured: 62MB idle → >400MB after two
		// --- bare big results, unrecoverable). Disabling history keeps the kernel flat: the
		// --- display hook still publishes results on iopub (single-mode execution, independent
		// --- of store_history), so the transcript keeps the value the retention would have held.
		// --- This test pins the bound: many result-producing cells leave Out/In at most one. ---
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("x = 40");
		for (let i = 0; i < 8; i++) {
			const r = await m.execute(`result_${i} = x + ${i}
result_${i}`);
			expect(r.status).toBe("ok");
			expect(r.result).toContain(String(40 + i));
		}

		// history must not grow: at most one Out slot (the latest result) and no In accumulation
		const probe = await m.execute(
			"print(len(get_ipython().user_ns.get('Out', {})) <= 1, len(get_ipython().user_ns.get('In', [])) <= 1)",
		);
		expect(probe.status).toBe("ok");
		expect(probe.stdout.trim()).toBe("True True");
	});

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
