/**
 * The preview scorer's specification.
 *
 * A collapsed cell has one line to say what it did. These tables pin, per cell
 * shape, which line wins and how it is presented: commands over plumbing,
 * subagent tasks over everything, file effects by verb and path, secrets never.
 */

import { describe, expect, test } from "bun:test";
import { descriptor, previewCell, previewShellCommand } from "../src/extension/preview-core.js";

interface Case {
	name: string;
	code: string;
	kind: "shell" | "agent" | "ts";
	text: string;
}

function run(cases: Case[]): void {
	for (const c of cases) {
		test(c.name, () => {
			const preview = previewCell(c.code);
			expect(preview.kind).toBe(c.kind);
			expect(preview.text).toBe(c.text);
		});
	}
}

describe("previewCell: shell", () => {
	run([
		{
			name: "the command wins over the const that holds its result",
			code: "const out = await Bun.$`bun test test/`.quiet();\nout.stdout.toString()",
			kind: "shell",
			text: "bun test test/",
		},
		{
			name: "a cd prefix becomes a location suffix, not the story",
			code: "const r = await Bun.$`cd /tmp/work/checkout && git log --oneline -3`.nothrow();",
			kind: "shell",
			text: "git log --oneline -3 (checkout)",
		},
		{
			name: "interpolated consts are resolved to their values",
			code: 'const dir = "/tmp/demo";\nawait Bun.$`mkdir -p ${dir}`;',
			kind: "shell",
			text: "mkdir -p /tmp/demo",
		},
		{
			name: "chain best-pick prefers the mutating command",
			code: "await Bun.$`export FOO=1; ls; rm -rf build`;",
			kind: "shell",
			text: "rm -rf build",
		},
		{
			name: "node_modules/.bin runners are unwrapped",
			code: "await Bun.$`./node_modules/.bin/vitest run --reporter=dot`;",
			kind: "shell",
			text: "vitest run --reporter=dot",
		},
		{
			name: "npm run collapses to the script name",
			code: "await Bun.$`npm run build --workspace pkg`;",
			kind: "shell",
			text: "npm build --workspace pkg",
		},
		{
			name: "a heredoc write previews the target file, not the body",
			code: 'await Bun.$`cat > /tmp/config.json <<EOF\n{"a": 1}\nEOF`;',
			kind: "shell",
			text: "write config.json",
		},
		{
			name: "an unclosed template (args still streaming) previews the partial command",
			code: "const out = await Bun.$`bun run build --tar",
			kind: "shell",
			text: "bun run build --tar",
		},
		{
			name: "a file write beats the mkdir that prepared for it",
			code: 'const p = "/tmp/rlm-demo/notes.md";\nawait Bun.$`mkdir -p /tmp/rlm-demo`.quiet();\nawait Bun.write(p, "# notes");',
			kind: "ts",
			text: "write /tmp/rlm-demo/notes.md",
		},
		{
			name: "a setup-only shell cell is still a shell cell",
			code: "await Bun.$`mkdir -p /tmp/scratch`;",
			kind: "shell",
			text: "mkdir -p /tmp/scratch",
		},
		{
			name: "trailing redirections are stripped from the descriptor",
			code: "const out = await Bun.$`bun test test/units.test.ts 2>&1`.quiet();",
			kind: "shell",
			text: "bun test test/units.test.ts",
		},
		{
			name: "multiple shell calls: the strongest command wins",
			code: 'await Bun.$`ls`;\nawait Bun.$`git commit -m "x"`;',
			kind: "shell",
			text: 'git commit -m "x"',
		},
	]);
});

describe("previewCell: agent", () => {
	run([
		{
			name: "a subagent spawn beats a shell command in the same cell",
			code: 'await Bun.$`mkdir -p out`;\nconst h = await rlm.run("Review the engine API", { name: "reviewer" });',
			kind: "agent",
			text: "reviewer: Review the engine API",
		},
		{
			name: "a template prompt is shown with consts resolved",
			code: 'const target = "src/engine/index.ts";\nawait rlm.run(`Audit ${target} for races`);',
			kind: "agent",
			text: "Audit src/engine/index.ts for races",
		},
		{
			name: "an identifier prompt resolves through a string const",
			code: 'const prompt = "summarize README";\nawait rlm.run(prompt);',
			kind: "agent",
			text: "summarize README",
		},
		{
			name: "fan-out counts the extra spawns",
			code: 'await rlm.run("analyze a.ts");\nawait rlm.run("analyze b.ts");\nawait rlm.run("analyze c.ts");',
			kind: "agent",
			text: "analyze a.ts (+2 more)",
		},
		{
			name: "shell syntax inside a prompt is not mistaken for a shell cell",
			code: 'await rlm.run("run Bun.$`bun test` and report failures");',
			kind: "agent",
			text: "run Bun.$`bun test` and report failures",
		},
	]);
});

describe("previewCell: file effects and fetch", () => {
	run([
		{
			name: "Bun.write shows the verb and the path",
			code: 'const report = lines.join("\\n");\nawait Bun.write("/tmp/report.md", report);',
			kind: "ts",
			text: "write /tmp/report.md",
		},
		{
			name: "a path held in a const resolves",
			code: 'const target = "/tmp/out.json";\nawait Bun.write(target, data);',
			kind: "ts",
			text: "write /tmp/out.json",
		},
		{
			name: "Bun.file reads show as reads",
			code: 'const cfg = await Bun.file("package.json").json();\ncfg.version',
			kind: "ts",
			text: "read package.json",
		},
		{
			name: "fs mutations map to verbs",
			code: 'import { rmSync } from "node:fs";\nrmSync("/tmp/scratch", { recursive: true });',
			kind: "ts",
			text: "delete /tmp/scratch",
		},
		{
			name: "fetch shows the URL",
			code: 'const res = await fetch("https://api.github.com/repos/oven-sh/bun");\nres.status',
			kind: "ts",
			text: "fetch https://api.github.com/repos/oven-sh/bun",
		},
	]);
});

describe("previewCell: bridged host tools", () => {
	run([
		{
			name: "tools.read previews as a read of its path",
			code: 'const reply = await tools.read({ path: "src/engine/index.ts" });\nreply.text.length',
			kind: "ts",
			text: "read src/engine/index.ts",
		},
		{
			name: "tools.edit previews as an edit of its path",
			code: 'await tools.edit({ path: "config.ts", edits: [{ oldText: "a", newText: "b" }] });',
			kind: "ts",
			text: "edit config.ts",
		},
		{
			name: "tools.write outranks the const above it",
			code: 'const body = render();\nawait tools.write({ path: "/tmp/out.md", content: body });',
			kind: "ts",
			text: "write /tmp/out.md",
		},
		{
			name: "tools.bash previews the command itself",
			code: 'await tools.bash({ command: "bun test test/", timeout: 60 });',
			kind: "ts",
			text: "bun test test/",
		},
	]);
});

describe("previewCell: generic TypeScript", () => {
	run([
		{
			name: "a meaningful call beats the boilerplate const above it",
			code: "const T = performance.now();\nconst results = await runBenchmark(suite);\nresults.length",
			kind: "ts",
			text: "const results = await runBenchmark(suite);",
		},
		{
			name: "imports and comments never win",
			code: '// setup\nimport { x } from "y";\nconst n = compute(x);',
			kind: "ts",
			text: "const n = compute(x);",
		},
		{
			name: "console.log unwraps to the call it prints",
			code: "console.log(analyze(data));",
			kind: "ts",
			text: "analyze(data)",
		},
		{
			name: "a bare call statement outranks an assignment",
			code: "const opts = { a: 1 };\nawait migrate(opts);",
			kind: "ts",
			text: "await migrate(opts);",
		},
		{
			name: "empty code previews as empty",
			code: "",
			kind: "ts",
			text: "",
		},
	]);
});

describe("descriptor hygiene", () => {
	test("collapses whitespace and caps at 64 characters", () => {
		expect(descriptor("a   b\n\t c")).toBe("a b c");
		// Words, not one run of characters — an unbroken 100-char run is a blob
		// and gets redacted instead of truncated.
		const long = "word ".repeat(30);
		expect(descriptor(long).length).toBe(64);
		expect(descriptor(long).endsWith("…")).toBe(true);
	});

	test("redacts secrets and giant blobs", () => {
		expect(descriptor('const apiKey = "sk-abc123"')).toContain("<redacted>");
		expect(descriptor('token="hunter2secret"')).toBe("token=<redacted>");
		expect(descriptor("A".repeat(120))).toBe("<blob>");
	});
});

describe("previewShellCommand", () => {
	test("skips setup lines and comments to find the real command", () => {
		expect(previewShellCommand("# comment\nexport PATH=/x\nbun test")).toBe("bun test");
	});

	test("a lone cd contributes location, not content", () => {
		expect(previewShellCommand("cd /tmp/proj\nbun run check")).toBe("bun run check (proj)");
	});
});
