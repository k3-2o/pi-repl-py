// --- pure layout, free of pi imports so unit tests can drive it directly ---

export interface ExecuteDetails {
	status?: "ok" | "error" | "aborted" | string;
	durationMs?: number;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
	audits?: AuditEntry[];
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
import { type AuditEntry, type AuditRenderDeps, renderAuditDetails, renderAuditSummary } from "./render-audit.js";

export type StatusKind = "error" | "aborted" | "running" | "queued" | "done";
export type BgKind = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface RenderDeps {
	fg(color: string, text: string): string;
	getBgAnsi(bg: BgKind): string;
	highlight(code: string, language?: string): string[];
	keyHint(expanded: boolean): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	/** Optional markdown renderer; if absent, output is treated as plain text. */
	renderMarkdown?(text: string, width: number): string[];
	/** Whether to render nested tool-call audits at all. */
	showAudits: boolean;
	/** Whether audit details are drawn in bordered boxes. */
	borderBoxes: boolean;
	/** Whether to use markdown rendering when output looks like markdown. */
	useMarkdown: boolean;
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
				// --- skip the 38;5;n / 38;2;r;g;b payload so a component isn't read as another SGR code ---
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

function highlightLines(code: string, language: string, deps: RenderDeps): string[] {
	if (!code) return [];
	return deps.highlight(code, language);
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

	// --- suffix priority: expand hint > error > duration > counts, so truncation never hides the expand key ---
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
	// --- budget: width minus leading space, prefix, suffix, and separators ---
	const fixed = 1 + deps.visibleWidth(prefix) + separatorWidth + deps.visibleWidth(suffix);
	const previewBudget = Math.max(8, width - fixed - separatorWidth);
	// --- a semantic preview is a one-line summary; highlight Python code, accent shell/agent intent ---
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
	// --- strip ANSI SGR/CSI and escape control chars for a readable TUI; tabs expand, CR becomes ␍ ---
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
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
	const highlighted = highlightLines(code, "python", deps);
	for (const [index, rawLine] of code.split("\n").entries()) {
		const prefix = index === 0 ? deps.fg("dim", "› ") : deps.fg("dim", "  ");
		// --- code is already highlighted; don't strip its ANSI ---
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

	// --- stdout/stderr/result are color-coded; sanitize before section color so our ANSI isn't escaped ---
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
		for (const line of text.split("\n")) {
			const safe = sanitizeTuiOutput(line || " ");
			addWrapped(output, OUTPUT_INDENT, deps.fg(color, safe), width, deps, { sanitize: false });
		}
	}

	if (!renderedText && !details && state.contentText?.trim()) {
		renderedText = true;
		const color = state.isError ? "error" : "toolOutput";
		for (const line of state.contentText.trim().split("\n")) {
			const safe = sanitizeTuiOutput(line || " ");
			addWrapped(output, OUTPUT_INDENT, deps.fg(color, safe), width, deps, { sanitize: false });
		}
	}

	if (details?.errorStack && details.errorStack.length > 0) {
		output.push(` ${OUTPUT_INDENT}${deps.fg("dim", "traceback:")}`);
		for (const line of details.errorStack) {
			const safe = sanitizeTuiOutput(line || " ");
			addWrapped(output, OUTPUT_INDENT, deps.fg("error", safe), width, deps, { sanitize: false });
		}
	}

	if (!renderedText) {
		const message = state.isPartial || statusKind(state) === "running" ? "waiting for output..." : "no output";
		addWrapped(output, OUTPUT_INDENT, deps.fg("muted", message), width, deps, { sanitize: false });
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
	// --- nested tool-call audits: collapsed summary, expanded bordered boxes ---
	const audits = deps.showAudits ? details?.audits : undefined;
	if (audits && audits.length > 0) {
		if (state.expanded) {
			if (lines.length > 0 && hasCode) lines.push("");
			lines.push(` ${OUTPUT_INDENT}${deps.fg("dim", "nested calls:")}`);
			for (const line of renderAuditDetails(audits, Math.max(4, width - 2), deps as AuditRenderDeps)) {
				lines.push(`  ${line}`);
			}
		} else {
			const summary = renderAuditSummary(audits, deps as AuditRenderDeps);
			if (summary) lines.push(` ${OUTPUT_INDENT}${summary}`);
		}
	}
}
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
	return [...renderExecuteHeader(state, width, deps), ...renderExecuteBody(state, width, deps)];
}
