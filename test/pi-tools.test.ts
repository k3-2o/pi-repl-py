/**
 * The host-tools bridge: pi's builtin tools mounted inside the evaluator.
 *
 * The bar for this surface: mount, round-trip, validation that teaches,
 * unknown names that suggest, abort that propagates to host-side work, image
 * forwarding, details preservation, and namespace survival across a bridged
 * call. Everything runs against a real engine and pi's real ToolDefinitions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/engine/index.js";
import { createPiToolsHost } from "../src/extension/pi-tools.js";

const managers: EngineManager[] = [];
const tempDirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "rlm-pitools-"));
	tempDirs.push(dir);
	return dir;
}

function bridgedEngine(cwd: string) {
	const host = createPiToolsHost({ cwd });
	const m = new EngineManager({ cwd, hostHandlers: host.handlers });
	managers.push(m);
	return { m, host };
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((m) => m.kill()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A real 1x1 red PNG, so the read tool takes its image path.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("pi tools bridge", () => {
	test("all seven tools are mounted and described from their schemas", () => {
		const { host } = bridgedEngine(workspace());
		const described = host.describe();
		expect(described).toHaveLength(7);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(described.some((line) => line.startsWith(`tools.${name}(`))).toBe(true);
		}
		// Signatures come from the TypeBox schemas, not hand-written strings.
		expect(described.find((line) => line.startsWith("tools.read("))).toContain("path: string");
		// Array parameters expand one item level: "edits: array" invites a wrong
		// guess at the shape; the expanded form answers it.
		expect(described.find((line) => line.startsWith("tools.edit("))).toContain(
			"edits: [{ oldText: string, newText: string }]",
		);
	});

	test("round-trip: a cell reads a file through the bridge and gets text plus details", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "hello.txt"), "alpha\nbeta\n");
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'const reply = await tools.read({ path: "hello.txt" });\n' +
				'`${reply.text.includes("beta")}|${reply.images}|${typeof reply.details}`',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true|0|object");
	});

	test("validation failure teaches: names the problem and shows the signature", async () => {
		const { m } = bridgedEngine(workspace());
		const r = await m.execute('await tools.read({ offset: "x" });');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("invalid arguments");
		expect(r.error?.message).toContain("read({ path: string, offset?: number, limit?: number })");
	});

	test("unknown tool names suggest the nearest real one", async () => {
		const { m } = bridgedEngine(workspace());
		const r = await m.execute('await tools.call("raed", { path: "x" });');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain('Did you mean "read"?');
		expect(r.error?.message).toContain("Available: read, bash, edit, write, grep, find, ls");
	});

	test("aborting the cell aborts the bridged tool's host-side work", async () => {
		const { m } = bridgedEngine(workspace());
		const controller = new AbortController();
		const started = Date.now();
		const running = m.execute('await tools.bash({ command: "sleep 30" }); "finished"', {
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 500));
		controller.abort();
		const r = await running;
		// Well under the sleep: the host-side bash subprocess was killed by the
		// propagated signal rather than run to completion.
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(r.status).toBe("aborted");
	});

	test("image blocks are held host-side and reported by count to the guest", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "dot.png"), TINY_PNG);
		const { m, host } = bridgedEngine(dir);
		const r = await m.execute('const reply = await tools.read({ path: "dot.png" });\nreply.images');
		expect(r.status).toBe("ok");
		expect(r.result).toContain("1");
		const images = host.drainImages();
		expect(images).toHaveLength(1);
		expect(images[0]?.mimeType).toBe("image/png");
		expect(images[0]?.data.length).toBeGreaterThan(50);
		// Draining is one-shot: the next cell must not inherit these blocks.
		expect(host.drainImages()).toHaveLength(0);
	});

	test("read replies carry raw content without reader notices", async () => {
		// A truncated read appends "[N more lines...]" guidance into text — right
		// for a transcript, fatal for JSON.parse. raw is the content alone.
		const dir = workspace();
		writeFileSync(join(dir, "data.json"), '{"answer": 42}');
		writeFileSync(join(dir, "long.txt"), Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n"));
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'const whole = await tools.read({ path: "data.json" });\n' +
				'const part = await tools.read({ path: "long.txt", limit: 5 });\n' +
				'`${JSON.parse(whole.raw).answer}|${part.text.includes("more lines")}|${part.raw.endsWith("row 4")}`',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("42|true|true");
	});

	test("tool details cross the bridge intact", async () => {
		// pi's tools only attach details when there is something structured to
		// say — a truncated read attaches truncation facts. Those must arrive in
		// the guest as data, not be flattened away by the protocol.
		const dir = workspace();
		writeFileSync(join(dir, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'const reply = await tools.read({ path: "big.txt" });\n' +
				"`total=${reply.details.truncation.totalLines} truncated=${reply.details.truncation.truncated}`",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("total=3000 truncated=true");
	});

	test("full read then edit: no nudge", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "seen.ts"), "export const a = 1;\n");
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'await tools.read({ path: "seen.ts" });\n' +
				'const reply = await tools.edit({ path: "seen.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] });\n' +
				"reply.text",
		);
		expect(r.status).toBe("ok");
		expect(r.result).not.toContain("never read in full");
	});

	test("locating with grep is not reading: edit without a full read carries the nudge", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "unseen.ts"), "export const a = 1;\n");
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'await tools.grep({ pattern: "a = 1", path: "." });\n' +
				'const reply = await tools.edit({ path: "unseen.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] });\n' +
				"reply.text",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("never read in full via tools.read");
		// The nudge is soft: the edit itself succeeded.
		expect((await m.execute('(await tools.read({ path: "unseen.ts" })).raw')).result).toContain("a = 2");
	});

	test("a truncated read is not a full read", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "huge.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'await tools.read({ path: "huge.txt" });\n' + // truncated by the reader's own cap
				'const reply = await tools.edit({ path: "huge.txt", edits: [{ oldText: "line 1\\n", newText: "line one\\n" }] });\n' +
				"reply.text",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("never read in full");
	});

	test("a limited read is not a full read either", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "windowed.ts"), "export const a = 1;\nexport const b = 2;\n");
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'await tools.read({ path: "windowed.ts", limit: 1 });\n' +
				'const reply = await tools.edit({ path: "windowed.ts", edits: [{ oldText: "b = 2", newText: "b = 3" }] });\n' +
				"reply.text",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("never read in full");
	});

	test("a file the session itself created is exempt", async () => {
		const dir = workspace();
		const { m } = bridgedEngine(dir);
		const r = await m.execute(
			'const w = await tools.write({ path: "fresh.ts", content: "export const a = 1;\\n" });\n' +
				'const e = await tools.edit({ path: "fresh.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] });\n' +
				'w.text + "|" + e.text',
		);
		expect(r.status).toBe("ok");
		expect(r.result).not.toContain("never read in full");
	});

	test("overwriting an existing file never seen whole carries the nudge", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "existing.md"), "# original\n");
		const { m } = bridgedEngine(dir);
		const r = await m.execute('(await tools.write({ path: "existing.md", content: "# replaced\\n" })).text');
		expect(r.status).toBe("ok");
		expect(r.result).toContain("never read in full");
	});

	test("namespace survives a bridged call and an edit lands on disk", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "config.ts"), "export const level = 1;\n");
		const { m } = bridgedEngine(dir);
		const first = await m.execute(
			'const marker = "still-here";\n' +
				'await tools.edit({ path: "config.ts", edits: [{ oldText: "level = 1", newText: "level = 2" }] });\n' +
				'"edited"',
		);
		expect(first.status).toBe("ok");
		const second = await m.execute("marker");
		expect(second.status).toBe("ok");
		expect(second.result).toContain("still-here");
		const third = await m.execute('(await tools.read({ path: "config.ts" })).text');
		expect(third.result).toContain("level = 2");
	});
});
