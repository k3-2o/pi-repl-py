/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * protocol framing and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHelperDirs } from "../src/engine/helpers-locate.js";
import type { RestoreResult } from "../src/engine/index.js";
import {
	capLinesForContext,
	EngineManager,
	FORCED_SNAPSHOT_MAX_BYTES,
	MAX_OUTPUT_LINE_CHARS,
	pruneOrphanedSnapshotDirs,
	pruneSnapshotDirs,
} from "../src/engine/index.js";
import { KernelClient } from "../src/engine/kernel.js";
import { type ConnectionFile, isTrustedMessage, JupyterSession } from "../src/engine/session.js";
import { encodeFrame, ZmtpFrameParser } from "../src/engine/zmtp.js";
import { buildHelpersMap, buildHelpersMapForCwd, buildHelpersPromptSection } from "../src/extension/helpers.js";
import { buildPromptGuidelines } from "../src/extension/prompt.js";
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
import {
	EngineLifecycle,
	type EngineLifecycleDeps,
	formatHelperFailuresLine,
	formatHelperToast,
	formatResetToast,
	type RevivableEngine,
} from "../src/extension/session-engine.js";
import { withSkillsBlock } from "../src/extension/skill-hook.js";
import {
	forkParentSnapshot,
	inheritForkSnapshot,
	resolveStateDir,
	sessionStateDirName,
} from "../src/extension/state-layout.js";

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

describe("helper boot announcements", () => {
	function withEnv(key: string, value: string | undefined, fn: () => void) {
		const prev = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
	}

	test("the per-session prompt section lists the cwd's helpers, or is absent", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-sec-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web(q) the PROJECT version."""\ndef web(q): return "project"\n',
		);
		withEnv("PI_HELPERS_GLOBAL_DIR", global, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block).toBeDefined();
			expect(block).toContain("Preloaded helpers");
			expect(block).toContain("web(q) the PROJECT version.");
		});
		const empty = mkdtempSync(join(tmpdir(), "pi-repl-sec-empty-"));
		expect(buildHelpersPromptSection(empty)).toBeUndefined();
	});

	test("PI_HELPERS_DIR replaces the whole tier list in the prompt section, like the kernel", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-sec-dir-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "project_only.py"), 'helper_description = """project"""\n');
		writeFileSync(join(dir, "override.py"), 'helper_description = """override"""\n');
		withEnv("PI_HELPERS_DIR", dir, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block?.includes("override")).toBe(true);
			expect(block?.includes("project_only")).toBe(false); // project tier is replaced, not merged
		});
		withEnv("PI_HELPERS_GLOBAL_DIR", undefined, () => {});
	});

	test("PI_HELPERS_GLOBAL_DIR swaps the global tier, not the project walk", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-sec-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "core.py"), 'helper_description = """core"""\n');
		writeFileSync(join(global, "extra.py"), 'helper_description = """extra"""\n');
		withEnv("PI_HELPERS_GLOBAL_DIR", global, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block?.includes("core")).toBe(true);
			expect(block?.includes("extra")).toBe(true);
		});
	});

	test("a file without a description points at the triple-quoted contract", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(join(dir, "bare.py"), "def bare(x):\n    return x\n");
		const bullet = buildHelpersMap(dir).find((b) => b.includes("bare"));
		expect(bullet).toContain("triple-quoted");
		expect(bullet).toContain("bare.__doc__");
	});

	test("formatHelperFailuresLine: silent when good, one line when broken", () => {
		expect(formatHelperFailuresLine(null)).toBeUndefined();
		expect(
			formatHelperFailuresLine([
				{ name: "web", ok: true },
				{ name: "core", ok: true },
			]),
		).toBeUndefined();
		const line = formatHelperFailuresLine([
			{ name: "web", ok: true },
			{ name: "scraper", ok: false, error: "NameError: x is not defined" },
		]);
		expect(line).toContain("<repl_helpers_failed:");
		expect(line).toContain("scraper (NameError: x is not defined)");
		expect(line).not.toContain("web");
	});

	test("formatHelperToast: names the loaded set and appends failures", () => {
		const good = formatHelperToast([
			{ name: "web", ok: true },
			{ name: "core", ok: true },
		]);
		expect(good).toBe("repl helpers loaded: web, core");
		const mixed = formatHelperToast([
			{ name: "web", ok: true },
			{ name: "scraper", ok: false, error: "SyntaxError: invalid syntax" },
		]);
		expect(mixed).toContain("web");
		expect(mixed).toContain("failed: scraper (SyntaxError: invalid syntax)");
		const none = formatHelperToast([{ name: "scraper", ok: false, error: "boom" }]);
		expect(none).toBe("repl no helpers loaded · failed: scraper (boom)");
	});

	test("static guidelines teach both markers and carry no concrete helper list", () => {
		const bullets = buildPromptGuidelines();
		expect(bullets.some((b) => b.includes("<repl_engine_reset>"))).toBe(true);
		expect(bullets.some((b) => b.includes("<repl_helpers_failed>"))).toBe(true);
		expect(bullets.some((b) => b.includes("Preloaded helpers"))).toBe(false); // the rosters move to the system prompt
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

	test("isTrustedMessage routes only verified traffic", () => {
		expect(isTrustedMessage(null)).toBe(false); // malformed
		expect(isTrustedMessage({ signatureOk: false } as never)).toBe(false); // unsigned / bad HMAC
		expect(isTrustedMessage({ signatureOk: true } as never)).toBe(true); // verified
	});

	test("a wrong-type reply does not satisfy a pending wait (parent id alone is not enough)", () => {
		// KernelClient's runtime constructor does not spawn anything — build it directly so the
		// private reply router is testable without a kernel process.
		const Seam = KernelClient as unknown as new (
			conn: ConnectionFile,
			opts: object,
		) => {
			pendingReplies: Map<string, { resolve(m: unknown): void; expectedType: string }>;
			resolveReply(msg: { msg_type: string; parent: { msg_id: string } }): void;
		};
		const kc = new Seam(
			{
				ip: "127.0.0.1",
				transport: "tcp",
				shell_port: 1,
				iopub_port: 2,
				stdin_port: 3,
				control_port: 4,
				hb_port: 5,
				key: "k",
				signature_scheme: "hmac-sha256",
			},
			{},
		);
		let resolved: unknown;
		kc.pendingReplies.set("probe-1", {
			resolve: (m) => {
				resolved = m;
			},
			expectedType: "kernel_info_reply",
		});
		// a shell/control reply riding the probe's parent must not settle the wait
		kc.resolveReply({ msg_type: "execute_reply", parent: { msg_id: "probe-1" } });
		expect(resolved).toBeUndefined();
		expect(kc.pendingReplies.has("probe-1")).toBe(true);
		// the awaited type does
		kc.resolveReply({ msg_type: "kernel_info_reply", parent: { msg_id: "probe-1" } });
		expect(resolved).toMatchObject({ msg_type: "kernel_info_reply" });
		expect(kc.pendingReplies.has("probe-1")).toBe(false);
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

	test("a pure-traceback error cell does not claim it had no output", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: {
				status: "error",
				errorName: "ZeroDivisionError",
				errorStack: ["Traceback (most recent call last):", "ZeroDivisionError: division by zero"],
			},
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("traceback:");
		expect(plain).toContain("ZeroDivisionError");
		expect(plain).not.toContain("no output");
	});

	test("the expanded panel always ends with a cushion row, never text on the edge", () => {
		const deps = testDeps();
		const cases: Array<{ name: string; details: any; expectText: string }> = [
			// traceback renders bare (no trailing newline) and must still get the cushion
			{
				name: "traceback",
				details: { status: "error", errorName: "E", errorStack: ["Traceback (most recent call last):", "E: boom"] },
				expectText: "E: boom",
			},
			// the placeholder renders bare and must also sit above the edge
			{ name: "placeholder", details: { status: "ok", durationMs: 5 }, expectText: "no output" },
			// a result repr carries no trailing newline either
			{ name: "result", details: { status: "ok", result: "'res'" }, expectText: "'res'" },
		];
		for (const { name, details, expectText } of cases) {
			const lines = renderExecuteBody(makeState({ expanded: true, details }), 80, deps);
			const last = stripAnsi(lines[lines.length - 1]).trim();
			const above = stripAnsi(lines[lines.length - 2]).trim();
			expect(last, `${name}: bottom row must be blank`).toBe("");
			expect(above, `${name}: content sits above the cushion`).toContain(expectText);
		}
		// blob paths already ended blank via the stream's trailing newline; the cushion must
		// recognize that row and not stack a second one
		const streamed = renderExecuteBody(
			makeState({ expanded: true, details: { status: "ok", stdout: "hi\n" } }),
			80,
			deps,
		);
		expect(stripAnsi(streamed[streamed.length - 1]).trim()).toBe("");
		expect(stripAnsi(streamed[streamed.length - 2]).trim()).toBe("hi");
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
	// --- a fake engine so the lifecycle policy is testable without a kernel. start() hangs
	// --- to simulate a wedged boot; the restore result is settleable by the test so the
	// --- async-recovery contract (acquire never waits, notice follows completion) is provable. ---
	class FakeEngine implements RevivableEngine {
		readonly started: boolean[] = [];
		private resolveRestore!: (r: RestoreResult | null) => void;
		private restoreSettled: Promise<RestoreResult | null>;
		constructor(
			private readonly restore: RestoreResult | null,
			readonly history: boolean,
			private readonly hang = false,
			readonly skip: boolean = false,
			pending = false,
		) {
			// a skipped engine's recovery settles null, exactly like EngineManager
			this.restoreSettled = pending
				? new Promise((resolve) => {
						this.resolveRestore = resolve;
					})
				: Promise.resolve(skip ? null : this.restore);
		}
		async start(): Promise<void> {
			this.started.push(this.skip); // records the skip flag each boot attempt
			if (this.hang) return new Promise<never>(() => {});
		}
		restoreResult(): Promise<RestoreResult | null> {
			return this.restoreSettled;
		}
		/** Settle a pending recovery, as the engine's quiet-gap restore would. */
		finishRestore(r: RestoreResult | null): void {
			this.resolveRestore(r);
		}
		restoreWasSkipped(): boolean {
			return this.skip;
		}
		hasSnapshotHistory(): boolean {
			return this.history;
		}
	}

	const deps = (restore: RestoreResult | null, history: boolean) =>
		({
			create: (skip?: boolean) => new FakeEngine(restore, history, false, skip ?? false),
			async dispose() {},
		}) as EngineLifecycleDeps<FakeEngine>;

	const restored = (n: string[]): RestoreResult => ({ path: "/tmp/ns.snapshot", restored: n, failed: [] });

	// --- notices land once the (background) recovery settles; the fakes above resolve it on
	// --- the microtask queue, so by the time acquire() has returned the notice is present ---

	test("a mid-session rebuild announces on the next cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), false));
		await lc.acquire("cell");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("Revived (1): data");
	});

	test("a resumed conversation announces its restore on the first cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data", "model"]), true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("started fresh");
		expect(notice?.notice).toContain("Revived (2): data, model");
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
		expect(notice?.notice).toContain("no saved snapshot was available to revive");
	});

	test("a partial revive names the losses", async () => {
		const failed = [{ name: "handle", reason: "can't pickle" }];
		const lc = new EngineLifecycle(deps({ path: "/tmp/ns.snapshot", restored: ["ok"], failed }, true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("Lost (1): handle");
		expect(notice?.notice).toContain("cannot be snapshotted");
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

	test("acquire returns before a slow recovery completes; the notice follows the restore", async () => {
		const created: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(null, true, false, skip ?? false, true); // pending restore
				created.push(e);
				return e;
			},
			async dispose() {},
		});
		const acquire = lc.acquire("startup"); // not awaited until the guard below
		const { engine, created: wasCreated } = await acquire;
		expect(wasCreated).toBe(true);
		// the recovery is still in flight: acquire must have returned without it
		expect(lc.takeResetNotice()).toBeUndefined();
		// the quiet-gap restore settles later; the notice lands then
		created[0]!.finishRestore(restored(["data"]));
		await new Promise((resolve) => setImmediate(resolve));
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("Revived (1): data");
		expect(engine).toBe(created[0]);
	});

	test("a different conversation's acquire replaces the engine instead of bleeding into it", async () => {
		const created: FakeEngine[] = [];
		const disposed: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(restored(["conv-state"]), true, false, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose(e) {
				disposed.push(e);
			},
		});
		await lc.acquire("startup", "conv-A");
		await lc.acquire("cell", "conv-A"); // same conversation: the engine is reused, not rebuilt
		expect(created).toHaveLength(1);
		const first = created[0]!;
		await lc.acquire("startup", "conv-B"); // different conversation: flush + rebuild
		expect(disposed).toEqual([first]);
		expect(created).toHaveLength(2);
		// the new conversation got its own engine + its own (fresh) announcement
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("started fresh");
		expect(notice?.notice).toContain("Revived (1): conv-state");
	});

	test("an engine bound to no key serves any acquire without a teardown", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), true));
		await lc.acquire("startup");
		await lc.acquire("cell", "some-key"); // key appears later: nothing to bleed, no teardown
		expect(lc.takeResetNotice()).toBeDefined();
	});

	test("a wedged recovery is announced as skipped, honestly", async () => {
		// the engine's restore-cell watchdog found a poisoned pickle, killed the kernel, and
		// marked ITSELF skipped (restoreResult settles null, restoreWasSkipped is true): the
		// lifecycle must say "wedged; skipped", never "no snapshot available"
		const lc = new EngineLifecycle<FakeEngine>({
			create: () => new FakeEngine(null, true, false, true),
			async dispose() {},
		});
		const { engine } = await lc.acquire("cell");
		expect(engine.restoreWasSkipped()).toBe(true);
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("wedged");
		expect(notice?.notice).toContain("skipped");
		expect(notice?.restore).toBe(null);
		expect(notice?.wedged).toBe(true);
	});

	test("the reset toast is terse and agrees with the marker's counts", () => {
		// rebuilt mid-session with a full revive
		expect(formatResetToast("cell", restored(["a", "b"]))).toBe("repl kernel rebuilt, 2 names revived");
		// revived some, lost some
		expect(formatResetToast("cell", { path: "/tmp/x", restored: ["a"], failed: [{ name: "h", reason: "r" }] })).toBe(
			"repl kernel rebuilt, 1 name revived, 1 lost",
		);
		// resumed conversation
		expect(formatResetToast("startup", restored(["data"]))).toBe("repl session resumed, 1 name revived");
		// nothing saved vs nothing revived are distinct and accurate
		expect(formatResetToast("cell", null)).toBe("repl kernel rebuilt, nothing saved to revive");
		expect(formatResetToast("startup", { path: "/tmp/x", restored: [], failed: [] })).toBe(
			"repl session resumed, nothing could be revived",
		);
		// a wedged revive names the skip so nobody mistakes it for "nothing saved"
		expect(formatResetToast("cell", null, true)).toBe("repl kernel rebuilt, snapshot revive skipped (wedged)");
		expect(formatResetToast("startup", null, true)).toBe("repl session resumed, snapshot revive skipped (wedged)");
	});

	test("a boot that wedges is killed and retried fresh, with the snapshot skipped honestly", async () => {
		const created: FakeEngine[] = [];
		const discarded: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const hang = created.length === 0; // first engine hangs at boot
				const e = new FakeEngine(hang ? null : restored(["data"]), true, hang, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose() {},
			async discard(e) {
				discarded.push(e);
			},
			bootTimeoutMs: 40,
		});
		const { engine, restore } = await lc.acquire("cell");
		expect(engine).toBe(created[1]);
		expect(restore).toBe(null);
		expect(discarded).toEqual([created[0]]);
		// the retry booted WITHOUT the snapshot, so the poisoned snapshot can't wedge twice
		expect(created[1]!.skip).toBe(true);
		expect(created[1]!.started).toEqual([true]);
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("wedged");
		expect(notice?.notice).toContain("skipped");
		expect(notice?.restore).toBe(null);
	});

	test("a boot that wedges twice fails loudly instead of hanging the session", async () => {
		const created: FakeEngine[] = [];
		const discarded: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(null, true, true, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose() {},
			async discard(e) {
				discarded.push(e);
			},
			bootTimeoutMs: 40,
		});
		await expect(lc.acquire("cell")).rejects.toThrow("timed out twice");
		expect(created).toHaveLength(2);
		expect(discarded).toEqual(created);
	});
});

describe("session state layout: keys never collide across conversations", () => {
	test("the state dir key joins the project slug with the conversation name", () => {
		expect(sessionStateDirName("/root/sessions/--proj-a--/2026-01-01T00-00-00Z_111.jsonl")).toBe(
			"--proj-a--__2026-01-01T00-00-00Z_111",
		);
		// two conversations with the same basename in different projects get different keys
		const a = sessionStateDirName("/root/sessions/--proj-a--/shared.jsonl");
		const b = sessionStateDirName("/root/sessions/--proj-b--/shared.jsonl");
		expect(a).not.toBe(b);
	});

	test("a legacy bare-name dir migrates to the slug key on the owning conversation's start", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-statekey-"));
		try {
			const sessions = join(root, "sessions");
			const state = join(root, "state");
			mkdirSync(join(sessions, "--proj-a--"), { recursive: true });
			const conv = "2026-01-01T00-00-00Z_111";
			writeFileSync(join(sessions, "--proj-a--", `${conv}.jsonl`), "x");
			// pre-slug dir exists for this conversation
			const legacy = join(state, conv);
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "namespace.snapshot"), "{}");
			const resolved = resolveStateDir(state, join(sessions, "--proj-a--", `${conv}.jsonl`));
			expect(resolved.snapshotPath).toBe(join(state, `--proj-a--__${conv}`, "namespace.snapshot"));
			expect(existsSync(resolved.snapshotPath)).toBe(true); // migrated, so the snapshot survives
			expect(existsSync(legacy)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("migration is skipped when the slug dir already owns a snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-statekey-"));
		try {
			const state = join(root, "state");
			const dir = join(state, "--proj-a--__conv");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "namespace.snapshot"), "newer");
			const legacy = join(state, "conv");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "namespace.snapshot"), "older");
			const resolved = resolveStateDir(state, join(root, "sessions", "--proj-a--", "conv.jsonl"));
			expect(resolved.snapshotPath).toBe(join(dir, "namespace.snapshot"));
			expect(readFileSync(resolved.snapshotPath, "utf8")).toBe("newer");
			expect(existsSync(legacy)).toBe(true); // untouched; the orphan sweep sees it as live
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
	test("the orphan sweep recognizes both legacy and slug-keyed dirs, so deletion cleans both", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		const sessions = mkdtempSync(join(tmpdir(), "pi-repl-sess-"));
		try {
			// proj-a: alive.jsonl (slug dir) and carryover.jsonl (legacy pre-slug dir, not yet migrated)
			const a = join(sessions, "--proj-a--");
			mkdirSync(a);
			writeFileSync(join(a, "alive.jsonl"), "x");
			writeFileSync(join(a, "carryover.jsonl"), "x");
			// proj-b: deleted.jsonl was deleted → both its dir formats must be swept
			const b = join(sessions, "--proj-b--");
			mkdirSync(b);
			const mk = (name: string) => {
				const d = join(root, name);
				mkdirSync(d);
				writeFileSync(join(d, "namespace.snapshot"), "{}");
				return d;
			};
			const aliveSlug = mk("--proj-a--__alive");
			const carryoverLegacy = mk("carryover"); // live conversation, legacy format: kept
			const deletedSlug = mk("--proj-b--__deleted");
			const deletedLegacy = mk("deleted"); // same conversation's pre-slug dir: swept too
			const ephemeral = mk("ephemeral");

			const removed = pruneOrphanedSnapshotDirs(root, sessions, "--proj-a--__alive");
			expect(removed).toBe(2);
			expect(existsSync(aliveSlug)).toBe(true);
			expect(existsSync(carryoverLegacy)).toBe(true);
			expect(existsSync(deletedSlug)).toBe(false);
			expect(existsSync(deletedLegacy)).toBe(false);
			expect(existsSync(ephemeral)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(sessions, { recursive: true, force: true });
		}
	});
});

describe("snapshot gate retry", () => {
	// The name-diff gate may only advance on a PERSISTED snapshot: a failed write must leave
	// it in place, or a transient failure would silently end every later snapshot. The fake
	// kernel below drives the real EngineManager gate + debounce through its private seam.
	function gatedEngine(
		onSnapshot: () => Promise<{ entries: never[]; failed: never[]; complete: boolean }>,
		opts: { periodMs?: number } = {},
	) {
		const d = mkdtempSync(join(tmpdir(), "pi-repl-gate-"));
		const m = new EngineManager({
			cwd: d,
			snapshot: { path: join(d, "ns.snapshot"), debounceMs: 1, periodMs: opts.periodMs ?? 0 },
		});
		const anyM = m as unknown as {
			kernel: object;
			state: string;
			lastNamespaceNames: string[] | undefined;
			lastPersistedAt: number;
			lastSnapshotBytes: number;
			scheduleSnapshotIfChanged(): Promise<void>;
		};
		anyM.state = "running";
		anyM.lastNamespaceNames = [];
		anyM.lastPersistedAt = 0;
		anyM.lastSnapshotBytes = 0;
		anyM.kernel = {
			listNames: async () => ["a"],
			snapshot: onSnapshot,
		} as never;
		return anyM;
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

	test("a failed snapshot leaves the gate in place, so the next cell retries", async () => {
		let snapshotCalls = 0;
		const m = gatedEngine(async () => {
			snapshotCalls += 1;
			return { entries: [], failed: [], complete: false };
		});
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(1);
		// same names, gate never advanced → the diff is still visible and the debounce re-arms
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(2);
	});

	test("a persisted snapshot advances the gate and stops re-arming", async () => {
		let snapshotCalls = 0;
		const m = gatedEngine(async () => {
			snapshotCalls += 1;
			return { entries: [], failed: [], complete: true };
		});
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(1);
		// the write succeeded; the gate now holds today's names → unchanged cells skip
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(1);
	});

	test("a stale snapshot forces a refresh even when names are unchanged", async () => {
		let snapshotCalls = 0;
		const m = gatedEngine(
			async () => {
				snapshotCalls += 1;
				return { entries: [], failed: [], complete: true };
			},
			{ periodMs: 50 },
		);
		m.lastNamespaceNames = ["a"]; // names unchanged...
		m.lastPersistedAt = Date.now() - 100; // ...but the last snapshot is stale
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(1);
		// the refresh persisted and reset the clock -> the next cell stays quiet
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(1);
	});

	test("a recent snapshot does not force a refresh", async () => {
		let snapshotCalls = 0;
		const m = gatedEngine(
			async () => {
				snapshotCalls += 1;
				return { entries: [], failed: [], complete: true };
			},
			{ periodMs: 50 },
		);
		m.lastNamespaceNames = ["a"];
		m.lastPersistedAt = Date.now();
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(0);
	});

	test("the forced pass stands down for already-heavy namespaces", async () => {
		let snapshotCalls = 0;
		const m = gatedEngine(
			async () => {
				snapshotCalls += 1;
				return { entries: [], failed: [], complete: true };
			},
			{ periodMs: 50 },
		);
		m.lastNamespaceNames = ["a"];
		m.lastPersistedAt = Date.now() - 100;
		m.lastSnapshotBytes = FORCED_SNAPSHOT_MAX_BYTES + 1;
		await m.scheduleSnapshotIfChanged();
		await settle();
		expect(snapshotCalls).toBe(0);
	});
});

describe("fork inheritance", () => {
	function forkWorld() {
		const stateRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-state-"));
		const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-sessions-"));
		const slugDir = join(sessionsRoot, "proj-a");
		mkdirSync(slugDir, { recursive: true });
		const parentFile = join(slugDir, "parent.jsonl");
		const forkFile = join(slugDir, "forked.jsonl");
		writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
		return { stateRoot, parentFile, forkFile };
	}

	const parentSnap = (stateRoot: string, parentFile: string) => resolveStateDir(stateRoot, parentFile).snapshotPath;
	const forkSnap = (stateRoot: string, forkFile: string) => resolveStateDir(stateRoot, forkFile).snapshotPath;

	test("a fork with a parentSession copies the parent's snapshot exactly once", () => {
		const { stateRoot, parentFile, forkFile } = forkWorld();
		mkdirSync(dirname(parentSnap(stateRoot, parentFile)), { recursive: true });
		writeFileSync(parentSnap(stateRoot, parentFile), '{"version":3,"entries":[]}');
		writeFileSync(forkFile, JSON.stringify({ type: "session", parentSession: parentFile }));

		const target = forkSnap(stateRoot, forkFile);
		expect(existsSync(target)).toBe(false);
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(readFileSync(target, "utf8")).toBe('{"version":3,"entries":[]}');
		expect(existsSync(`${target}.tmp`)).toBe(false); // atomic copy leaves no temp
		expect(readFileSync(parentSnap(stateRoot, parentFile), "utf8")).toBe('{"version":3,"entries":[]}'); // parent untouched

		// idempotent: a fork that already has history is never overwritten
		writeFileSync(target, "newer-fork-history");
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(readFileSync(target, "utf8")).toBe("newer-fork-history");
	});

	test("a fork whose parent never snapshotted stays empty", () => {
		const { stateRoot, parentFile, forkFile } = forkWorld();
		writeFileSync(forkFile, JSON.stringify({ type: "session", parentSession: parentFile }));
		const target = forkSnap(stateRoot, forkFile);
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(existsSync(target)).toBe(false);
	});

	test("a resumed session (no parentSession) is untouched", () => {
		const { stateRoot, forkFile } = forkWorld();
		writeFileSync(forkFile, '{"type":"session","version":3,"id":"plain"}\n');
		forkParentSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile));
		inheritForkSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile));
		expect(existsSync(forkSnap(stateRoot, forkFile))).toBe(false);
	});

	test("an unreadable session file is not treated as a fork", () => {
		const { stateRoot, forkFile } = forkWorld();
		writeFileSync(forkFile, "not json at all");
		expect(forkParentSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile))).toBeUndefined();
	});
});
