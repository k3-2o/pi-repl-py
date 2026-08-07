/**
 * The subagent contract: what a parent gets back when it delegates.
 *
 * Spawning returns a handle at admission, the registry tracks each child's
 * fate, and results arrive as files. These tests inject the spawn command so
 * they exercise the contract without launching real agents; that the real
 * command works is established separately against a live child.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/engine/index.js";
import { createSubagentHost, defaultSubagentName } from "../src/extension/subagents.js";

const managers: EngineManager[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-rlm-sub-"));
	tempDirs.push(d);
	return d;
}

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((m) => m.kill()));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHost(dir: string, script = 'echo "child-output-proof"') {
	return createSubagentHost({
		cwd: dir,
		subagentDir: dir,
		defaultModel: "anthropic/haiku",
		depth: 0,
		maxDepth: 2,
		spawnCommand: () => ({ command: "sh", args: ["-c", script] }),
	});
}

describe("subagent host", () => {
	test("rlm.run admits immediately with a handle; child result lands in output_file", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			'const h = await rlm.run("summarize the repo"); `${h.rlm_child_id.startsWith("sub-")}:${h.name.startsWith("subagent-")}`',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true:true");

		// Child (sh -c echo) finishes quickly; its stdout is the output file.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const entry = host.entries()[0];
		expect(entry.status).toBe("completed");
		expect(readFileSync(entry.output_file, "utf8")).toContain("child-output-proof");
	});

	test("guest can poll rlm.listSubagents until completed, then read the output file in-cell", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			`
			const h = await rlm.run("do the thing");
			let entry;
			for (let i = 0; i < 50; i++) {
				const { subagents } = await rlm.listSubagents();
				entry = subagents.find((s) => s.rlm_child_id === h.rlm_child_id);
				if (entry.status !== "running") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const output = await Bun.file(entry.output_file).text();
			\`\${entry.status}|\${output.trim()}\`
			`,
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("completed|child-output-proof");
	});

	test("failed child is reported as error in the registry", async () => {
		const d = tempDir();
		const host = fakeHost(d, "exit 3");
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		await m.execute('await rlm.run("doomed task");');
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(host.entries()[0].status).toBe("error");
	});

	test("depth limit refuses recursion beyond maxDepth", async () => {
		const d = tempDir();
		const host = createSubagentHost({
			cwd: d,
			subagentDir: d,
			defaultModel: "anthropic/haiku",
			depth: 2,
			maxDepth: 2,
			spawnCommand: () => ({ command: "sh", args: ["-c", "echo nope"] }),
		});
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute('await rlm.run("too deep");');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("depth");
	});

	test("delete_subagent kills a running child and removes it", async () => {
		const d = tempDir();
		const host = fakeHost(d, "sleep 60");
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			'const h = await rlm.run("long task"); const del = await rlm.deleteSubagent(h.rlm_child_id); del.subagent.rlm_child_id === h.rlm_child_id',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true");
		expect(host.entries()).toHaveLength(0);
	});

	test("names: explicit name respected, oversized rejected, default is a slug", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r1 = await m.execute('(await rlm.run("t", { name: "my-worker" })).name');
		// The registry speaks the same field: a poll matching on `name` must work.
		const listed = await m.execute(
			'(await rlm.listSubagents()).subagents.find((s) => s.name === "my-worker") !== undefined',
		);
		expect(listed.result).toContain("true");
		expect(r1.result).toContain("my-worker");
		const r2 = await m.execute(`await rlm.run("t", { name: "${"x".repeat(80)}" });`);
		expect(r2.status).toBe("error");
		expect(r2.error?.message).toContain("64");
		expect(defaultSubagentName("Fix the parser bug!", "sub-abc12345")).toMatch(
			/^subagent-fix-the-parser-bug-[a-z0-9]+$/,
		);
	});
});
