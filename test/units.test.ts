/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * protocol framing and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage } from "../src/engine/protocol.js";
import { buildHelpersMap } from "../src/extension/helpers.js";
import {
	backgroundFor,
	closeOpenSgr,
	type ExecuteRenderState,
	formatDuration,
	paintBackground,
	type RenderDeps,
	renderExecuteBody,
	renderExecuteCell,
	renderExecuteHeader,
	statusKind,
} from "../src/extension/render-core.js";

describe("helpers loader: description is the truth", () => {
	test("helper_description renders verbatim, including the call shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		// First def is a private helper; only the description may define the surface.
		writeFileSync(
			join(dir, "web_search.py"),
			[
				'helper_description = """web_search(query, intent="fact") — Unified web search.',
				'Instead of: hand-rolling urllib/requests against one provider and hoping the key is set."""',
				"",
				"def _get_env(key):",
				"    return ''",
				"",
				'def web_search(query, intent="fact"):',
				"    ...",
			].join("\n"),
		);
		const bullets = buildHelpersMap(dir);
		const bullet = bullets.find((b) => b.includes("web_search"));
		expect(bullet).toBeDefined();
		expect(bullet).toContain('web_search(query, intent="fact") — Unified web search.');
		expect(bullet).toContain("Instead of: hand-rolling urllib/requests");
		// The private helper must never leak into the advertised surface.
		expect(bullet).not.toContain("_get_env");
	});

	test("a file without a description falls back to a help() pointer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(join(dir, "bare.py"), "def bare(x):\n    return x\n");
		const bullet = buildHelpersMap(dir).find((b) => b.includes("bare"));
		expect(bullet).toContain("call help('bare')");
	});

	test("the helpers dir is the single source — its content is the surface", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(
			join(dir, "combine.py"),
			'helper_description = """combine(a, b) — takes the pair."""\ndef combine(a, b):\n    return a + b\n',
		);
		const bullets = buildHelpersMap(dir);
		expect(bullets.filter((b) => b.startsWith("- combine("))).toHaveLength(1);
		expect(bullets.find((b) => b.startsWith("- combine("))).toContain("takes the pair");
	});
});

describe("protocol framing", () => {
	test("encode produces exactly one newline-terminated envelope line", () => {
		const line = encodeMessage({ type: "ping", id: "p1" });
		expect(line.endsWith("\n")).toBe(true);
		expect(line.trimEnd().split("\n")).toHaveLength(1);
		expect(line).toContain('"__repl":1');
	});

	test("round-trips a message", () => {
		const decoded = decodeMessage<{ type: string; id: string }>(encodeMessage({ type: "pong", id: "abc" }));
		expect(decoded).toMatchObject({ type: "pong", id: "abc" });
	});

	test("rejects non-envelope, malformed, and typeless lines", () => {
		expect(decodeMessage("plain subprocess output")).toBeNull();
		expect(decodeMessage('{"__repl":1, broken json')).toBeNull();
		expect(decodeMessage(JSON.stringify({ __repl: 1 }))).toBeNull();
		expect(decodeMessage(JSON.stringify({ __repl: 2, type: "done" }))).toBeNull();
		expect(decodeMessage("")).toBeNull();
	});
});

// ── render-core ───────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

function testDeps(overrides: Partial<RenderDeps> = {}): RenderDeps {
	return {
		fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
		getBgAnsi: () => "\x1b[44m",
		highlight: (code) => code.split("\n").map((line) => `\x1b[32m${line}\x1b[0m`),
		keyHint: (expanded) => (expanded ? "ctrl+o to collapse" : "ctrl+o to expand"),
		visibleWidth: (text) => stripAnsi(text).length,
		truncateToWidth: (text, width, ellipsis = "") => {
			// ANSI-aware like the real primitive: keep escapes, count only visible
			// characters, and append the ellipsis when content was dropped.
			const plainLength = stripAnsi(text).length;
			if (plainLength <= width) return text;
			const budget = Math.max(0, width - stripAnsi(ellipsis).length);
			let visible = 0;
			let out = "";
			let index = 0;
			while (index < text.length) {
				const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
				if (match) {
					out += match[0];
					index += match[0].length;
					continue;
				}
				if (visible >= budget) break;
				out += text[index];
				visible += 1;
				index += 1;
			}
			return out + ellipsis;
		},
		wrapTextWithAnsi: (text, width) => {
			const plain = stripAnsi(text);
			if (plain.length <= width) return [text];
			const chunks: string[] = [];
			for (let i = 0; i < plain.length; i += width) chunks.push(plain.slice(i, i + width));
			return chunks;
		},
		now: () => 0,
		...overrides,
	};
}

function makeState(overrides: Partial<ExecuteRenderState> = {}): ExecuteRenderState {
	return {
		code: "const a = 1;\na + 1",
		details: { status: "ok", durationMs: 120, stdout: "hello\n", result: "2" },
		isPartial: false,
		isError: false,
		expanded: false,
		executionStarted: true,
		hasResult: true,
		...overrides,
	};
}

describe("render-core: helpers", () => {
	test("closeOpenSgr resets colors left open by wrapping", () => {
		expect(closeOpenSgr("\x1b[31mred")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("\x1b[38;5;10mgreen")).toBe("\x1b[38;5;10mgreen\x1b[0m");
		expect(closeOpenSgr("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("plain")).toBe("plain");
	});

	test("a Python cell containing a Bun.$ literal is still syntax-highlighted", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: 'print("Bun.\\$ is not special here")' });
		const rendered = renderExecuteCell(state, 80, deps);
		// The mock highlighter wraps every line in green — not accent, and the
		// whole cell must not be downgraded to a single flat color.
		expect(rendered.join("\n")).toContain("\x1b[32m");
	});

	test("formatDuration switches units at one second", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration(120)).toBe("120ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("statusKind and backgroundFor agree on every state", () => {
		expect(statusKind(makeState())).toBe("done");
		expect(statusKind(makeState({ isError: true }))).toBe("error");
		expect(statusKind(makeState({ details: { status: "aborted" } }))).toBe("aborted");
		expect(statusKind(makeState({ details: undefined, hasResult: false, isPartial: true }))).toBe("running");
		expect(statusKind(makeState({ details: undefined, hasResult: false, executionStarted: false }))).toBe("queued");

		expect(backgroundFor("done")).toBe("toolSuccessBg");
		expect(backgroundFor("error")).toBe("toolErrorBg");
		expect(backgroundFor("aborted")).toBe("toolErrorBg");
		expect(backgroundFor("running")).toBe("toolPendingBg");
		expect(backgroundFor("queued")).toBe("toolPendingBg");
	});
});

describe("render-core: layout", () => {
	test("collapsed renders exactly one row; expanded renders code and output", () => {
		const deps = testDeps();
		const collapsed = renderExecuteCell(makeState(), 80, deps);
		expect(collapsed).toHaveLength(1);

		const expanded = renderExecuteCell(makeState({ expanded: true }), 80, deps);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		const joined = stripAnsi(expanded.join("\n"));
		expect(joined).toContain("const a = 1;");
		expect(joined).toContain("hello");
	});

	test("header and body split reconstructs the full cell", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true });
		const full = renderExecuteCell(state, 80, deps);
		const header = renderExecuteHeader(state, 80, deps);
		const body = renderExecuteBody(state, 80, deps);
		expect(header).toHaveLength(1);
		expect(stripAnsi(header[0])).toBe(stripAnsi(full[0]));
		expect([...header, ...body]).toHaveLength(full.length);
		expect(stripAnsi([...header, ...body].join("\n"))).toBe(stripAnsi(full.join("\n")));

		const collapsedBody = renderExecuteBody(makeState({ expanded: false }), 80, deps);
		expect(collapsedBody).toHaveLength(0);
	});

	test("every rendered line fits the pane width, at any width", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
			details: { status: "ok", durationMs: 90, stdout: "x".repeat(400), result: "y".repeat(200) },
		});
		for (const width of [20, 40, 80, 120, 200]) {
			for (const line of renderExecuteCell(state, width, deps)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a long first line keeps the trailing metadata visible", () => {
		const deps = testDeps();
		const state = makeState({
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
		});
		// The preview absorbs truncation so the metadata suffix survives at any
		// width that can hold it; the preview is elided instead of the counts,
		// duration, and expand hint.
		for (const width of [80, 100, 140]) {
			const row = stripAnsi(renderExecuteCell(state, width, deps)[0]);
			expect(row).toContain("ctrl+o to expand");
			expect(row).toContain("120ms");
			expect(row).toContain("↑ 1");
			expect(row).toContain("const co");
			expect(row).toContain("…");
			expect(row.length).toBeLessThanOrEqual(width);
		}
	});

	test("status glyph and background track the cell status", () => {
		const deps = testDeps();
		expect(stripAnsi(renderExecuteCell(makeState(), 80, deps)[0])).toContain("✓");
		expect(stripAnsi(renderExecuteCell(makeState({ isError: true }), 80, deps)[0])).toContain("✗");
		const queued = makeState({ details: undefined, hasResult: false, executionStarted: false });
		expect(stripAnsi(renderExecuteCell(queued, 80, deps)[0])).toContain("◇");
	});

	test("line counts and duration appear in the collapsed row", () => {
		const deps = testDeps();
		const row = stripAnsi(renderExecuteCell(makeState(), 200, deps)[0]);
		expect(row).toContain("↑ 2");
		expect(row).toContain("lines");
		expect(row).toContain("120ms");
		expect(row).toContain("ctrl+o to expand");
	});

	test("error name and stack are surfaced", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: { status: "error", errorName: "RangeError", errorStack: ["RangeError: demo explosion", "  at cell"] },
		});
		const rendered = stripAnsi(renderExecuteCell(state, 120, deps).join("\n"));
		expect(rendered).toContain("RangeError");
		expect(rendered).toContain("demo explosion");
	});

	test("empty output says so; a running cell says it is waiting", () => {
		const deps = testDeps();
		const done = makeState({ expanded: true, details: { status: "ok", durationMs: 5 } });
		expect(stripAnsi(renderExecuteCell(done, 80, deps).join("\n"))).toContain("no output");
		const running = makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true });
		expect(stripAnsi(renderExecuteCell(running, 80, deps).join("\n"))).toContain("waiting for output");
	});

	test("output ANSI escapes are stripped before section coloring is applied", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: {
				status: "ok",
				stdout: "\x1b[31mred\x1b[0m\n\x07beep\t",
				stderr: "\r\x00\x1b[1m",
			},
		});
		const raw = renderExecuteCell(state, 80, deps).join("\n");
		const plain = stripAnsi(raw);
		// User ANSI is stripped; our section color is applied afterward.
		expect(plain).toContain("red");
		expect(plain).toContain("beep");
		expect(plain).not.toContain("\x07");
		expect(plain).toContain("    "); // tab expanded
		expect(plain).toContain("stdout:");
		expect(plain).toContain("stderr:");
		expect(raw).toContain("␍"); // carriage return escaped as a control picture
		// color SGR must be stripped, not re-escaped into visible ␣[31m noise
		expect(raw).not.toContain("␛[31m");
		expect(raw).not.toContain("␛[0m");
	});

	test("stdout/stderr/result are labeled and color-coded", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: {
				status: "ok",
				stdout: "out",
				stderr: "err",
				result: "res",
			},
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("stdout:");
		expect(plain).toContain("stderr:");
		expect(plain).toContain("result:");
		expect(plain).toContain("out");
		expect(plain).toContain("err");
		expect(plain).toContain("res");
	});

	test("huge output is head/tail truncated with a hidden marker", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: { status: "ok", stdout: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") },
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("line 0");
		expect(plain).toContain("line 59");
		expect(plain).toContain("hidden");
		// Should not render every line.
		expect(plain.match(/line \d+/g)?.length).toBeLessThan(60);
	});

	test("background is re-armed after inner SGR resets so it spans the row", () => {
		const deps = testDeps();
		const painted = paintBackground("\x1b[31mred\x1b[0mplain", 20, "done", deps);
		expect(painted.startsWith("\x1b[44m")).toBe(true);
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		// Every reset inside the row must be followed by the background again.
		const resets = painted.split("\x1b[0m");
		for (const segment of resets.slice(1, -1)) expect(segment.startsWith("\x1b[44m")).toBe(true);
		expect(stripAnsi(painted)).toHaveLength(20);
	});
});
