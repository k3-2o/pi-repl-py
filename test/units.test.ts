/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * protocol framing and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "../src/engine/helpers-locate.js";
import type { RestoreResult } from "../src/engine/index.js";
import {
	capLinesForContext,
	EngineManager,
	MAX_OUTPUT_LINE_CHARS,
	pruneOrphanedSnapshotDirs,
	pruneSnapshotDirs,
} from "../src/engine/index.js";
import { JupyterSession } from "../src/engine/session.js";
import { encodeFrame, ZmtpFrameParser } from "../src/engine/zmtp.js";
import { buildHelpersMap, buildHelpersMapForCwd } from "../src/extension/helpers.js";
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
import { EngineLifecycle, type EngineLifecycleDeps, type RevivableEngine } from "../src/extension/session-engine.js";
import { withSkillsBlock } from "../src/extension/skill-hook.js";

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

	test("a file without a description falls back to a plain-Python pointer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(join(dir, "bare.py"), "def bare(x):\n    return x\n");
		const bullet = buildHelpersMap(dir).find((b) => b.includes("bare"));
		expect(bullet).toContain("bare.__doc__");
	});

	test("the helpers dir is the single source — its content is the surface", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(
			join(dir, "combine.py"),
			'helper_description = """combine(a, b) — takes the pair."""\ndef combine(a, b):\n    return a + b\n',
		);
		const bullets = buildHelpersMap(dir);
		// pi renders each guideline as "- <line>"; buildHelpersMap returns the bare line.
		expect(bullets.filter((b) => b.startsWith("combine("))).toHaveLength(1);
		expect(bullets.find((b) => b.startsWith("combine("))).toContain("takes the pair");
	});

	test("project helpers shadow same-named global helpers at the cwd", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web(query) the PROJECT version."""\ndef web(q): return "project"\n',
		);
		writeFileSync(
			join(global, "web.py"),
			'helper_description = """web(query) the GLOBAL version."""\ndef web(q): return "global"\n',
		);
		const bullets = buildHelpersMapForCwd(proj, global);
		const web = bullets.filter((b) => b.includes("web("));
		expect(web).toHaveLength(1);
		expect(web[0]).toContain("PROJECT");
		expect(web[0]).not.toContain("GLOBAL");
	});

	test("global helpers fill in what the project does not define", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "core.py"),
			'helper_description = """core() project."""\ndef core(): return 1\n',
		);
		writeFileSync(join(global, "web.py"), 'helper_description = """web() global."""\ndef web(): return 2\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("core()"))).toBe(true);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("a project without a helpers dir falls back to global only", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		writeFileSync(join(global, "web.py"), 'helper_description = """web() global."""\ndef web(): return 2\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("private underscore helpers never appear from either tier", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "_priv.py"), 'helper_description = """leak"""\ndef _priv(): pass\n');
		writeFileSync(join(global, "_priv2.py"), 'helper_description = """leak2"""\ndef _priv2(): pass\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("_priv"))).toBe(false);
	});

	test("works from a deep subfolder: .pi/helpers found at the git root", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		mkdirSync(join(proj, "src", "tools"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web() root."""\ndef web(): return 1\n',
		);
		const bullets = buildHelpersMapForCwd(join(proj, "src", "tools"), global);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("resolveHelperDirs stops the ancestor walk at the git root", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		mkdirSync(join(proj, "src", "deep"), { recursive: true });
		const dirs = resolveHelperDirs(join(proj, "src", "deep"), global);
		const nonGlobal = dirs.slice(0, -1);
		expect(nonGlobal).toEqual([join(proj, ".pi", "helpers")]);
		expect(dirs[dirs.length - 1]).toBe(global);
	});
});

describe("jupyter session framing", () => {
	test("buildFrames emits exactly [DELIM, sig, header, parent, metadata, content]", () => {
		const s = new JupyterSession({ key: "testkey" });
		const frames = s.buildFrames("kernel_info_request", {});
		expect(frames).toHaveLength(6);
		expect(frames[0].toString("utf8")).toBe("<IDS|MSG>");
		expect(frames[1]).toHaveLength(64); // hex SHA-256
		const header = JSON.parse(frames[2].toString("utf8"));
		expect(header.msg_type).toBe("kernel_info_request");
		expect(header.version).toBe("5.3");
		expect(header.session).toBe(s.sessionId);
	});

	test("a message round-trips with a verified signature", () => {
		const s = new JupyterSession({ key: "testkey" });
		const frames = s.buildFrames("execute_request", { code: "x = 1" });
		const parsed = s.parseMessage(frames);
		expect(parsed?.msg_type).toBe("execute_request");
		expect(parsed?.signatureOk).toBe(true);
		expect(parsed?.content.code).toBe("x = 1");
	});

	test("a tampered payload fails signature verification", () => {
		const s = new JupyterSession({ key: "testkey" });
		const frames = s.buildFrames("execute_request", { code: "x = 1" });
		const tampered = [...frames];
		tampered[5] = Buffer.from(JSON.stringify({ code: "x = 2" }));
		const parsed = s.parseMessage(tampered);
		expect(parsed?.content.code).toBe("x = 2");
		expect(parsed?.signatureOk).toBe(false);
	});

	test("an explicit msg_id is used verbatim (the kernel echoes it as parent)", () => {
		const s = new JupyterSession({ key: "k" });
		const frames = s.buildFrames("kernel_info_request", {}, null, "probe-1");
		expect(JSON.parse(frames[2].toString("utf8")).msg_id).toBe("probe-1");
	});

	test("malformed inbound messages are rejected", () => {
		const s = new JupyterSession({ key: "k" });
		expect(s.parseMessage([Buffer.from("no delim here")])).toBeNull();
		expect(s.parseMessage([Buffer.from("<IDS|MSG>"), Buffer.from("only-two")])).toBeNull();
		expect(s.parseMessage([Buffer.from("<IDS|MSG>"), Buffer.alloc(0), Buffer.from("not json")])).toBeNull();
	});
});

describe("zmtp framing", () => {
	test("short frames: flags byte + 1-byte length + body", () => {
		const frame = encodeFrame(Buffer.from("hello"), false);
		expect(frame).toHaveLength(7);
		expect(frame[0]).toBe(0);
		expect(frame[1]).toBe(5);
		expect(frame.subarray(2).toString("utf8")).toBe("hello");
	});

	test("the 'more' flag survives encoding", () => {
		const frame = encodeFrame(Buffer.from("part"), true);
		expect(frame[0] & 0x01).toBe(0x01);
	});

	test("long frames use the 8-byte length with the long flag", () => {
		const body = Buffer.alloc(300, 0x61);
		const frame = encodeFrame(body, false);
		expect(frame[0] & 0x02).toBe(0x02);
		expect(frame.readUInt32BE(5)).toBe(300);
		expect(frame.length).toBe(9 + 300);
	});

	test("the parser reassembles multipart messages from chunked input", () => {
		const parser = new ZmtpFrameParser();
		const a = encodeFrame(Buffer.from("one"), true);
		const b = encodeFrame(Buffer.from("two"), false);
		const wire = Buffer.concat([a, b]);
		const messages = parser.feed(wire.subarray(0, 4)).concat(parser.feed(wire.subarray(4)));
		expect(messages).toHaveLength(1);
		expect(messages[0].map((f) => f.toString("utf8"))).toEqual(["one", "two"]);
	});

	test("the parser holds partial frames until the bytes arrive", () => {
		const parser = new ZmtpFrameParser();
		expect(parser.feed(Buffer.from([0x00, 0x05, 0x68]))).toHaveLength(0); // 2 header bytes + 1 of 5 body bytes
		expect(parser.feed(Buffer.from("ello"))).toHaveLength(1);
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

	test("expanded output renders in full, bounded only by the data cap", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: { status: "ok", stdout: Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n") },
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("line 0");
		expect(plain).toContain("line 119");
		// Every line is present; nothing is hidden behind a marker.
		expect(plain).not.toContain("hidden");
		expect(plain.match(/line \d+/g)?.length).toBe(120);
	});

	test("appended streaming output re-wraps incrementally with identical results", () => {
		const deps = testDeps();
		const tail = "b".repeat(200);
		const big = `alpha\n${tail}\ngamma\ndelta`;
		const state = makeState({
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: `alpha\n${tail}`,
		});
		const first = renderExecuteBody(state, 80, deps);
		// Append the next batch on the same (persistent) state object.
		state.contentText = big;
		const second = renderExecuteBody(state, 80, deps);
		// Same text on a fresh state must wrap identically.
		const fresh = makeState({
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: big,
		});
		const full = renderExecuteBody(fresh, 80, deps);
		expect(second.length).toBeGreaterThan(first.length);
		expect(second.join("\n")).toBe(full.join("\n"));
		// Rendering the same text again is a cache hit and stays stable.
		expect(renderExecuteBody(state, 80, deps).join("\n")).toBe(full.join("\n"));
		// A mid-stream rewrite (not an append) falls back to a fresh full wrap.
		state.contentText = "zzz";
		const rewritten = renderExecuteBody(state, 80, deps);
		expect(stripAnsi(rewritten.join("\n"))).toContain("zzz");
		expect(rewritten.join("\n")).toBe(
			renderExecuteBody(
				makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true, contentText: "zzz" }),
				80,
				deps,
			).join("\n"),
		);
	});

	test("settled stdout reuses the streaming wrap when the text is identical", () => {
		const deps = testDeps();
		const body = "x".repeat(60) + "\n" + "y".repeat(60);
		const state = makeState({
			code: "",
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: body,
		});
		const streamed = renderExecuteBody(state, 80, deps).join("\n");
		// Settle: the engine delivers the same bytes as details.stdout.
		state.details = { status: "ok", durationMs: 5, stdout: body };
		state.isPartial = false;
		state.version = 1;
		const settled = renderExecuteBody(state, 80, deps).join("\n");
		expect(settled).toContain("stdout:");
		expect(stripAnsi(settled)).toContain("x".repeat(30));
		// The wrapped rows are the cached ones (label line aside): no re-wrap hitch at settle.
		expect(settled.slice(settled.indexOf("\n") + 1)).toBe(streamed);
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

describe("per-line output cap", () => {
	test("short lines pass through unchanged", () => {
		const { text, trimmed } = capLinesForContext("a\nbb\nccc\n");
		expect(trimmed).toBe(false);
		expect(text).toBe("a\nbb\nccc\n");
	});

	test("a single oversized line is trimmed to the per-line cap", () => {
		const { text, trimmed } = capLinesForContext(`${"x".repeat(10_000_000)}\n`);
		expect(trimmed).toBe(true);
		expect(text.split("\n")[0].length).toBe(MAX_OUTPUT_LINE_CHARS);
		expect(text.split("\n")[0]).not.toContain("xyz");
	});

	test("only the offending line is trimmed, neighbors are untouched", () => {
		const { text, trimmed } = capLinesForContext(`ok\n${"y".repeat(10_000)}\nfine`);
		expect(trimmed).toBe(true);
		const [a, b, c] = text.split("\n");
		expect(a).toBe("ok");
		expect(b.length).toBe(MAX_OUTPUT_LINE_CHARS);
		expect(c).toBe("fine");
	});
});

describe("skills advertisement in --repl (withSkillsBlock)", () => {
	const skill = {
		name: "session-memory",
		description: "Recall past pi conversations from session history.",
		filePath: "/home/k2/.pi/agent/skills/session-memory/SKILL.md",
		baseDir: "/home/k2/.pi/agent/skills/session-memory",
		sourceInfo: {} as any,
		disableModelInvocation: false,
	};

	// A prompt shaped like buildSystemPrompt's tail: project context then cwd last.
	const promptWithCwd = "You are an expert.\n</project_context>\nCurrent working directory: /home/k2/works";

	test("injects the block, with execute in place of read", () => {
		const out = withSkillsBlock(promptWithCwd, [skill]);
		expect(out).toBeDefined();
		// lands in pi's slot: before the cwd line, never inside it
		expect(out!.indexOf("<available_skills>")).toBeLessThan(out!.indexOf("Current working directory:"));
		expect(out).toContain("<name>session-memory</name>");
		expect(out).toContain("<description>Recall past pi conversations from session history.</description>");
		// repl-corrected loading line
		expect(out).toContain("via execute (read the file with Python)");
		expect(out).not.toContain("Use the read tool to load");
	});

	test("stays undefined with no skills", () => {
		expect(withSkillsBlock(promptWithCwd, [])).toBeUndefined();
	});

	test("stays undefined when the block is already present (read-capable pi)", () => {
		const already = promptWithCwd + "\n<available_skills>\n</available_skills>";
		expect(withSkillsBlock(already, [skill])).toBeUndefined();
	});

	test("appends at the end when there is no cwd marker", () => {
		const bare = "You are a bot.";
		const out = withSkillsBlock(bare, [skill]);
		expect(out!.endsWith("<available_skills>\n</available_skills>")).toBe(false);
		expect(out!.startsWith(bare)).toBe(true);
		expect(out).toContain("<name>session-memory</name>");
	});
});

describe("render-core: code indent on wrap", () => {
	test("continuation rows line up with the wrapped statement's indentation", () => {
		const deps = testDeps({
			wrapTextWithAnsi: (text: string, width: number) => {
				const chunks: string[] = [];
				let line = "";
				let i = 0;
				while (i < text.length) {
					if (text[i] === "\x1b") {
						const end = text.indexOf("m", i);
						line += text.slice(i, end + 1);
						i = end + 1;
					} else {
						line += text[i];
						if (stripAnsi(line).length >= width) {
							chunks.push(line);
							line = "";
						}
						i++;
					}
				}
				if (line) chunks.push(line);
				for (let c = 1; c < chunks.length; c++) chunks[c] = chunks[c].replace(/^[ \t]+/, "");
				return chunks.length ? chunks : [""];
			},
		});
		const state = makeState({
			code:
				"def scale(values):\n" +
				"    total = digitsum(every_token_that_gets_wrapped_along_the_row_here_padded)\n" +
				"    return total",
			expanded: true,
		});
		const lines = renderExecuteCell(state, 30, deps).map(stripAnsi);
		const target = 7;
		const statement = lines.filter(
			(l) => l.includes("digitsum") || l.includes("_that_gets_wrapped") || l.includes("_padded"),
		);
		expect(statement.length).toBeGreaterThan(1);
		for (const row of statement) {
			expect(row.length - row.trimStart().length).toBe(target);
		}
	});
});

describe("render-core: cached code re-render", () => {
	test("repeated frames render identically from the cache", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "def f(x):\n    return x * 2\nf(21)" });
		const first = renderExecuteBody(state, 60, deps);
		const second = renderExecuteBody(state, 60, deps);
		expect(second).toEqual(first);
		expect(second.join("\n")).toContain("def f(x)");
	});

	test("a changed body on the same state renders fresh, not stale", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "old_body = 1" });
		renderExecuteBody(state, 60, deps);
		state.code = "new_body = 2";
		const rendered = renderExecuteBody(state, 60, deps).join("\n");
		expect(rendered).toContain("new_body = 2");
		expect(rendered).not.toContain("old_body = 1");
	});

	test("width churn (resizes) stays correct after cache eviction", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "value = 'x' * 120\nprint(value)" });
		const reference = renderExecuteBody(state, 40, deps);
		[50, 70, 90, 110].forEach((w) => {
			renderExecuteBody(state, w, deps);
		});
		// the first width was evicted from the bound cache; re-render must rebuild it
		const again = renderExecuteBody(state, 40, deps);
		expect(again).toEqual(reference);
	});
});

describe("render-core: bare identifier coloring", () => {
	test("raw identifiers are painted with syntaxVariable; colored tokens are left alone", () => {
		const calls: Array<[string, string]> = [];
		const deps = testDeps({
			fg: (color: string, text: string) => {
				calls.push([color, text]);
				return `\x1b[38;2;1;2;3m${text}\x1b[39m`;
			},
			highlight: (code) =>
				code.split("\n").map((line) =>
					// only the word KEY is a pre-colored token; everything else is raw
					line.replace(/KEY/g, "\x1b[38;2;86;156;214mKEY\x1b[39m"),
				),
		});
		const state = makeState({
			code: "result = call_me(arg)\nKEY = 1",
			expanded: true,
		});
		renderExecuteCell(state, 40, deps);
		const ids = calls.filter(([c]) => c === "syntaxVariable").map(([, t]) => t);
		expect(ids).toContain("result");
		expect(ids).toContain("call_me");
		expect(ids).toContain("arg");
		expect(ids).not.toContain("KEY");
	});
});

describe("EngineLifecycle reset notices", () => {
	// --- a fake engine so the lifecycle policy is testable without a kernel ---
	class FakeEngine implements RevivableEngine {
		constructor(
			private readonly restore: RestoreResult | null,
			readonly history: boolean,
		) {}
		async restoreState(): Promise<RestoreResult | null> {
			return this.restore;
		}
		hasSnapshotHistory(): boolean {
			return this.history;
		}
	}

	const deps = (restore: RestoreResult | null, history: boolean) =>
		({
			create: () => new FakeEngine(restore, history),
			async dispose() {},
		}) as EngineLifecycleDeps<FakeEngine>;

	const restored = (n: string[]): RestoreResult => ({ path: "/tmp/ns.snapshot", restored: n, failed: [] });

	test("a mid-session rebuild announces on the next cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), false));
		await lc.acquire("cell");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice).toContain("Revived (1): data");
	});

	test("a resumed conversation announces its restore on the first cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data", "model"]), true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice).toContain("started fresh");
		expect(notice).toContain("Revived (2): data, model");
	});

	test("a first-ever session stays quiet", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), false));
		await lc.acquire("startup");
		expect(lc.takeResetNotice()).toBeUndefined();
	});

	test("a resumed conversation with no snapshot says so instead of pretending", async () => {
		const lc = new EngineLifecycle(deps(null, true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice).toContain("no saved snapshot was available to revive");
	});

	test("a partial revive names the losses", async () => {
		const failed = [{ name: "handle", reason: "can't pickle" }];
		const lc = new EngineLifecycle(deps({ path: "/tmp/ns.snapshot", restored: ["ok"], failed }, true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toContain("Lost (1): handle");
		expect(notice).toContain("cannot be snapshotted");
	});

	test("an existing engine never re-announces; the notice is taken exactly once", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), true));
		await lc.acquire("startup");
		expect(lc.takeResetNotice()).toBeDefined();
		expect(lc.takeResetNotice()).toBeUndefined();
		// a later cell acquire reuses the engine without a new notice
		await lc.acquire("cell");
		expect(lc.takeResetNotice()).toBeUndefined();
	});
});

describe("pruneSnapshotDirs keeps only the newest snapshots", () => {
	test("deletes oldest snapshot dirs and never the live one", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-prune-"));
		try {
			const mk = (name: string, ageMs: number) => {
				const dir = join(root, name);
				mkdirSync(dir, { recursive: true });
				const f = join(dir, "namespace.snapshot");
				writeFileSync(f, "{}");
				const t = Date.now() - ageMs;
				utimesSync(f, new Date(t), new Date(t));
				return dir;
			};
			const old1 = mk("old-1", 40 * 24 * 3600 * 1000);
			const old2 = mk("old-2", 30 * 24 * 3600 * 1000);
			const fresh = mk("fresh", 1000);
			mkdirSync(join(root, "no-manifest")); // unrelated dir with no snapshot: untouched
			pruneSnapshotDirs(root, 2);
			expect(existsSync(old1)).toBe(false);
			expect(existsSync(old2)).toBe(true);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(join(root, "no-manifest"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("orphaned snapshot dirs die with their conversation", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		const sessions = mkdtempSync(join(tmpdir(), "pi-repl-sess-"));
		try {
			// project roots under the sessions root; alpha/beta conversations survive
			const a = join(sessions, "proj-a");
			const b = join(sessions, "proj-b");
			mkdirSync(a);
			mkdirSync(b);
			writeFileSync(join(a, "alpha.jsonl"), "x");
			writeFileSync(join(b, "beta.jsonl"), "x");
			// state dirs keyed by conversation basename
			const mk = (name: string) => {
				const d = join(root, name);
				mkdirSync(d);
				writeFileSync(join(d, "namespace.snapshot"), "{}");
				return d;
			};
			const alpha = mk("alpha");
			const beta = mk("beta");
			const gamma = mk("gamma"); // conversation deleted everywhere
			const current = mk("current-session");
			const ephemeral = mk("ephemeral"); // no-session fallback: always kept
			mkdirSync(join(root, "random-dir")); // no manifest: must never be touched

			const removed = pruneOrphanedSnapshotDirs(root, sessions, "current-session");
			expect(removed).toBe(1);
			expect(existsSync(gamma)).toBe(false);
			expect(existsSync(alpha)).toBe(true); // file lives under proj-a
			expect(existsSync(beta)).toBe(true);
			expect(existsSync(current)).toBe(true);
			expect(existsSync(ephemeral)).toBe(true);
			expect(existsSync(join(root, "random-dir"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(sessions, { recursive: true, force: true });
		}
	});

	test("orphan sweep is a no-op without a sessions root", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		try {
			const d = join(root, "gamma");
			mkdirSync(d);
			writeFileSync(join(d, "namespace.snapshot"), "{}");
			expect(pruneOrphanedSnapshotDirs(root, undefined, undefined)).toBe(0);
			expect(existsSync(d)).toBe(true);
			expect(pruneOrphanedSnapshotDirs(root, join(root, "no-such-root"), undefined)).toBe(0);
			expect(existsSync(d)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
