/**
 * Pure layout logic for the `execute` cell renderer.
 *
 * Deliberately free of pi imports so it is unit-testable outside pi's runtime:
 * theme, syntax highlighting, key hints, and width primitives are injected.
 * `render.ts` binds the real implementations.
 */

export interface ExecuteDetails {
	status?: "ok" | "error" | "aborted" | string;
	durationMs?: number;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
}

export interface ExecuteRenderState {
	code: string;
	details?: ExecuteDetails;
	contentText?: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	executionStarted: boolean;
	hasResult: boolean;
}

import { previewCell } from "./preview-core.js";

export type StatusKind = "error" | "aborted" | "running" | "queued" | "done";
export type BgKind = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface RenderDeps {
	fg(color: string, text: string): string;
	getBgAnsi(bg: BgKind): string;
	highlight(code: string): string[];
	keyHint(expanded: boolean): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	/** Injected for deterministic spinner frames in tests. */
	now?(): number;
}

const OUTPUT_INDENT = "  ";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

export function isShellish(line: string): boolean {
	return line.includes("Bun.$`");
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append a reset when `line` ends with a foreground or background color still
 * open, so a span that wrapping split across lines cannot bleed into the
 * trailing padding or the next row.
 */
export function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : (match[1] ?? "").split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the payload of 38;5;n / 38;2;r;g;b so a component (e.g. 38)
				// is not read as another SGR code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function statusKind(state: ExecuteRenderState): StatusKind {
	const status = state.details?.status;
	if (state.isError || status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (!state.isPartial && (status !== undefined || state.hasResult)) return "done";
	if (state.isPartial || state.executionStarted) return "running";
	return "queued";
}

export function backgroundFor(kind: StatusKind): BgKind {
	if (kind === "error" || kind === "aborted") return "toolErrorBg";
	if (kind === "done") return "toolSuccessBg";
	return "toolPendingBg";
}

function marker(state: ExecuteRenderState, deps: RenderDeps): string {
	switch (statusKind(state)) {
		case "error":
			return deps.fg("error", "✗");
		case "aborted":
			return deps.fg("warning", "✗");
		case "done":
			return deps.fg("success", "✓");
		case "running": {
			const now = deps.now?.() ?? Date.now();
			return deps.fg("accent", SPINNER_FRAMES[Math.floor(now / 160) % SPINNER_FRAMES.length]);
		}
		default:
			return deps.fg("muted", "◇");
	}
}

function highlightLines(code: string, deps: RenderDeps): string[] {
	if (!code) return [];
	const lines = code.split("\n");
	if (lines.some((line) => isShellish(line))) {
		// Cells that contain Bun.$ templates are shell-ish; paint them as accent
		// rather than trying to syntax-highlight TypeScript/Bun syntax as Python.
		return lines.map((line) => deps.fg("accent", line));
	}
	return deps.highlight(code);
}

function outputText(state: ExecuteRenderState): string {
	const details = state.details;
	if (details && (details.stdout || details.stderr || details.result)) {
		return [details.stdout, details.stderr, details.result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
	}
	return state.contentText?.trim() ?? "";
}

function topLine(state: ExecuteRenderState, width: number, deps: RenderDeps): string {
	const code = state.code.trimEnd();
	const preview = previewCell(code);
	const language = preview.kind === "shell" ? "repl · shell" : preview.kind === "agent" ? "repl · agent" : "repl";
	const prefix = `${marker(state, deps)} ${deps.fg("muted", language)}`;

	// Fixed metadata after the preview must always survive; the preview
	// absorbs all truncation. Counts settle-only: live updates jitter the header.
	// Suffix order is by priority: the expand hint must survive first, then the
	// error, then duration, then counts. Truncation happens from the right, so
	// low-priority items are elided before the user loses the expand keybinding.
	const suffixParts: string[] = [];
	suffixParts.push(deps.keyHint(state.expanded));

	const errorName = !state.isPartial ? state.details?.errorName : undefined;
	if (errorName) {
		// --- the error message usually beats a bare name when it fits ---
		const summary = sanitizeTuiOutput(state.details?.errorStack?.[0] ?? "");
		suffixParts.push(deps.fg("error", summary && deps.visibleWidth(summary) <= 48 ? summary : errorName));
	}

	const duration = formatDuration(state.details?.durationMs);
	if (duration) suffixParts.push(deps.fg("muted", duration));

	// --- counts settle-only: live-updating them mid-stream jitters the header ---
	if (!state.isPartial && statusKind(state) !== "running") {
		const inputLines = code.split("\n").filter((line) => line.trim().length > 0).length;
		const output = outputText(state);
		const outputLines = output ? output.split("\n").length : 0;
		const counts: string[] = [];
		if (inputLines > 0) counts.push(`↑ ${inputLines}`);
		if (outputLines > 0) counts.push(`↓ ${outputLines}`);
		if (counts.length > 0) suffixParts.push(deps.fg("muted", `${counts.join(" ")} lines`));
	}

	const separator = deps.fg("dim", " · ");
	const separatorWidth = deps.visibleWidth(separator);
	const suffix = suffixParts.join(separator);
	// Budget: total width minus leading space, prefix, suffix, separators.
	const fixed = 1 + deps.visibleWidth(prefix) + separatorWidth + deps.visibleWidth(suffix);
	const previewBudget = Math.max(8, width - fixed - separatorWidth);
	// A semantic preview is a one-line summary of the code. Highlight Python
	// code the same way the expanded block is highlighted; shell/agent previews
	// stay accent-colored so they read as intent, not syntax.
	let middle = "";
	if (preview.text) {
		const previewText =
			preview.kind === "ts"
				? (deps.highlight(preview.text)[0] ?? deps.fg("accent", preview.text))
				: deps.fg("accent", preview.text);
		middle = deps.truncateToWidth(previewText, previewBudget, "…");
	} else if (!state.executionStarted) {
		middle = deps.fg("muted", "waiting for code");
	}

	return [prefix, ...(middle ? [middle] : []), suffix].join(separator);
}

function sanitizeTuiOutput(text: string): string {
	// Control characters from user code output can move the cursor, change
	// colors, or print zero-width glyphs that break the TUI layout. Following
	// pi-fabric's escapeControlChars, render the escape byte and CR as Unicode
	// control pictures so the user can see what was emitted instead of silently
	// stripping it. Tabs expand to 4 spaces; other controls become �.
	return text
		.replace(/\x1b/g, "␛")
		.replace(/\r/g, "␍")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, "�");
}

type PreviewEntry = { kind: "line"; line: string } | { kind: "hidden"; hidden: number };

/** Head/tail truncation with a hidden-line marker, adapted from pi-fabric. */
function selectPreviewLines(lines: string[], limit: number): PreviewEntry[] {
	const lineEntry = (line: string): PreviewEntry => ({ kind: "line", line });
	if (lines.length <= limit || limit <= 0) return lines.map(lineEntry);
	if (limit < 8) return [...lines.slice(0, limit).map(lineEntry), { kind: "hidden", hidden: lines.length - limit }];
	const head = Math.ceil(limit * 0.65);
	const tail = Math.max(1, limit - head - 1);
	return [
		...lines.slice(0, head).map(lineEntry),
		{ kind: "hidden", hidden: lines.length - head - tail },
		...lines.slice(-tail).map(lineEntry),
	];
}

function addWrapped(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
	deps: RenderDeps,
	options: { sanitize?: boolean } = {},
): void {
	const safe = options.sanitize === false ? text : sanitizeTuiOutput(text);
	const available = Math.max(1, width - 1 - deps.visibleWidth(prefix));
	const wrapped = deps.wrapTextWithAnsi(safe, available);
	for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
		const linePrefix = index === 0 ? prefix : " ".repeat(deps.visibleWidth(prefix));
		lines.push(deps.truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
	}
}

function renderCode(state: ExecuteRenderState, lines: string[], width: number, deps: RenderDeps): boolean {
	const code = state.code.trimEnd();
	if (!code) return false;
	lines.push("");
	const highlighted = highlightLines(code, deps);
	for (const [index, rawLine] of code.split("\n").entries()) {
		const prefix = index === 0 ? deps.fg("dim", "› ") : deps.fg("dim", "  ");
		// Code is already syntax-highlighted; don't strip its ANSI.
		addWrapped(lines, prefix, highlighted[index] ?? rawLine, width, deps, { sanitize: false });
	}
	return true;
}

const MAX_OUTPUT_LINES = 50;

function renderOutput(
	state: ExecuteRenderState,
	lines: string[],
	width: number,
	hasCode: boolean,
	deps: RenderDeps,
): void {
	const details = state.details;
	const output: string[] = [];

	// stdout/stderr/result are color-coded and labeled so you can tell which
	// stream a line came from at a glance.
	const sections: Array<{ text: string | undefined; color: string; label: string }> = [
		{ text: details?.stdout, color: "toolOutput", label: "stdout" },
		{ text: details?.stderr, color: "warning", label: "stderr" },
		{ text: details?.result, color: "accent", label: "result" },
	];
	let renderedText = false;
	for (const { text, color, label } of sections) {
		if (!text?.trim()) continue;
		renderedText = true;
		output.push(` ${OUTPUT_INDENT}${deps.fg("dim", `${label}:`)}`);
		for (const line of text.split("\n")) addWrapped(output, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
	}

	if (!renderedText && !details && state.contentText?.trim()) {
		renderedText = true;
		const color = state.isError ? "error" : "toolOutput";
		for (const line of state.contentText.trim().split("\n")) {
			addWrapped(output, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
		}
	}

	if (details?.errorStack && details.errorStack.length > 0) {
		output.push(` ${OUTPUT_INDENT}${deps.fg("dim", "traceback:")}`);
		for (const line of details.errorStack)
			addWrapped(output, OUTPUT_INDENT, deps.fg("error", line || " "), width, deps);
	}

	if (!renderedText) {
		const message = state.isPartial || statusKind(state) === "running" ? "waiting for output..." : "no output";
		addWrapped(output, OUTPUT_INDENT, deps.fg("muted", message), width, deps);
	}

	const entries = selectPreviewLines(output, MAX_OUTPUT_LINES);
	if (entries.length > 0 && hasCode) lines.push("");
	for (const entry of entries) {
		if (entry.kind === "hidden") {
			const marker = ` … ${entry.hidden} line${entry.hidden === 1 ? "" : "s"} hidden … `;
			lines.push(` ${OUTPUT_INDENT}${deps.fg("muted", marker)}`);
		} else {
			lines.push(entry.line);
		}
	}
}

/** Paint the status-matched panel background across the row, surviving inner SGR resets. */
export function paintBackground(line: string, width: number, kind: StatusKind, deps: RenderDeps): string {
	const bgAnsi = deps.getBgAnsi(backgroundFor(kind));
	const padded = line + " ".repeat(Math.max(0, width - deps.visibleWidth(line)));
	const rearmed = padded.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
	return `${bgAnsi}${rearmed}\x1b[0m`;
}

export function renderExecuteHeader(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	const safeWidth = Math.max(1, width);
	const line = deps.truncateToWidth(` ${topLine(state, safeWidth, deps)}`, safeWidth, "");
	const kind = statusKind(state);
	return [paintBackground(line, safeWidth, kind, deps)];
}

export function renderExecuteBody(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	if (!state.expanded) return [];
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	const hasCode = renderCode(state, lines, safeWidth, deps);
	renderOutput(state, lines, safeWidth, hasCode, deps);
	const kind = statusKind(state);
	return lines.map((line) => paintBackground(line, safeWidth, kind, deps));
}

export function renderExecuteCell(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [deps.truncateToWidth(` ${topLine(state, safeWidth, deps)}`, safeWidth, "")];
	if (state.expanded) {
		const hasCode = renderCode(state, lines, safeWidth, deps);
		renderOutput(state, lines, safeWidth, hasCode, deps);
	}
	const kind = statusKind(state);
	return lines.map((line) => paintBackground(line, safeWidth, kind, deps));
}
