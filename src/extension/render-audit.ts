// --- pure audit rendering: turn nested tool calls recorded by the guest into TUI rows ---
// No pi imports here; the adapter in render.ts provides the theme/color deps.

import { descriptor } from "./preview/descriptor.js";
import { previewShellCommand } from "./preview/shell.js";

export interface AuditEntry {
	ref: string;
	args?: Record<string, unknown>;
	result?: unknown;
	success?: boolean;
	error?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface AuditRenderDeps {
	fg(color: string, text: string): string;
	highlight(code: string, language?: string): string[];
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	renderMarkdown?(text: string, width: number): string[];
	showAudits: boolean;
	borderBoxes: boolean;
	useMarkdown: boolean;
}

const MAX_AUDIT_BODY_LINES = 24;
const AUDIT_BODY_HEAD = 16;
const AUDIT_BODY_TAIL = 7;

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeText(text: string): string {
	// --- same sanitization as render-core so control chars don't break the TUI ---
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b/g, "␛")
		.replace(/\r/g, "␍")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function auditArg(audit: AuditEntry, key: string): string | undefined {
	return stringOf(audit.args?.[key]);
}

function auditTitle(audit: AuditEntry, deps: AuditRenderDeps): string {
	const ref = audit.ref;
	const title = deps.fg("toolTitle", ref);
	if (ref === "bash") {
		const command = auditArg(audit, "command") ?? "";
		const preview = previewShellCommand(command);
		return `${title} ${deps.fg("dim", "$")} ${deps.fg("accent", preview || command || "(shell)")}`;
	}
	if (ref === "read" || ref === "write" || ref === "edit") {
		const path = auditArg(audit, "path") ?? "";
		return `${title} ${deps.fg("accent", path || "(path)")}`;
	}
	if (ref === "web_search") {
		const query = auditArg(audit, "query") ?? "";
		return `${title} ${deps.fg("accent", query || "(query)")}`;
	}
	// --- generic: show the first string argument, if any ---
	const first = Object.values(audit.args ?? {}).find((value): value is string => typeof value === "string");
	return first ? `${title} ${deps.fg("accent", descriptor(first))}` : title;
}

function languageFromPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const map: Record<string, string> = {
		py: "python",
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		sh: "bash",
		bash: "bash",
		rb: "ruby",
		rs: "rust",
		go: "go",
		c: "c",
		cpp: "cpp",
		h: "c",
		hpp: "cpp",
		cs: "csharp",
		java: "java",
		kts: "kotlin",
		sql: "sql",
		html: "html",
		css: "css",
	};
	return map[ext];
}

function looksLikeMarkdown(text: string): boolean {
	// --- quick heuristic: headings, lists, bold/italic, code fences, or links ---
	return /(?:^|\n)\s*(#{1,6}\s|[-*+]\s|```|\[.+?\]\(.+?\)|\*\*.+?\*\*|__.+?__)/.test(text);
}

function maybeRenderMarkdown(text: string, width: number, deps: AuditRenderDeps): string[] | undefined {
	if (!deps.useMarkdown || !deps.renderMarkdown || !looksLikeMarkdown(text)) return undefined;
	try {
		return deps.renderMarkdown(text, width);
	} catch {
		return undefined;
	}
}

function wrapBody(text: string, width: number, deps: AuditRenderDeps): string[] {
	const safe = safeText(text);
	return deps.wrapTextWithAnsi(safe, width);
}

function selectBodyLines(lines: string[]): string[] {
	if (lines.length <= MAX_AUDIT_BODY_LINES) return lines;
	if (MAX_AUDIT_BODY_LINES < 8)
		return [...lines.slice(0, MAX_AUDIT_BODY_LINES), `… ${lines.length - MAX_AUDIT_BODY_LINES} lines hidden …`];
	return [
		...lines.slice(0, AUDIT_BODY_HEAD),
		`… ${lines.length - AUDIT_BODY_HEAD - AUDIT_BODY_TAIL} lines hidden …`,
		...lines.slice(-AUDIT_BODY_TAIL),
	];
}

function auditResultString(audit: AuditEntry): string | undefined {
	if (audit.error) return audit.error;
	if (audit.result === undefined) return undefined;
	if (typeof audit.result === "string") return audit.result;
	const record = recordOf(audit.result);
	if (record) {
		if (typeof record.stdout === "string" && record.stdout) return record.stdout;
		if (typeof record.text === "string") return record.text;
		if (typeof record.output === "string") return record.output;
	}
	return JSON.stringify(audit.result, undefined, 2);
}

function auditBody(audit: AuditEntry, width: number, deps: AuditRenderDeps): string[] | undefined {
	const ref = audit.ref;

	// --- bash: prefer stdout from the CompletedProcess dict, then raw stdout-like result ---
	if (ref === "bash") {
		const result = auditResultString(audit);
		if (!result) return undefined;
		return selectBodyLines(wrapBody(result, width, deps));
	}

	// --- read: highlight file content by extension ---
	if (ref === "read") {
		const result = auditResultString(audit);
		if (!result) return undefined;
		const path = auditArg(audit, "path") ?? "";
		const lang = languageFromPath(path);
		let lines: string[];
		if (lang) {
			lines = deps.highlight(result, lang);
		} else {
			lines = maybeRenderMarkdown(result, width, deps) ?? wrapBody(result, width, deps);
		}
		return selectBodyLines(lines);
	}

	// --- write: show the content being written, highlighted by extension ---
	if (ref === "write") {
		const content = auditArg(audit, "content") ?? auditResultString(audit);
		if (!content) return undefined;
		const path = auditArg(audit, "path") ?? "";
		const lang = languageFromPath(path);
		let lines: string[];
		if (lang) {
			lines = deps.highlight(content, lang);
		} else {
			lines = maybeRenderMarkdown(content, width, deps) ?? wrapBody(content, width, deps);
		}
		return selectBodyLines(lines);
	}

	// --- edit: show old → new in a tiny unified-ish block ---
	if (ref === "edit") {
		const oldText = auditArg(audit, "old_string") ?? auditArg(audit, "oldText");
		const newText = auditArg(audit, "new_string") ?? auditArg(audit, "newText");
		if (!oldText || !newText) return undefined;
		const lines: string[] = [];
		lines.push(deps.fg("toolDiffRemoved", `- ${oldText.replace(/\n/g, "\n- ")}`));
		lines.push(deps.fg("toolDiffAdded", `+ ${newText.replace(/\n/g, "\n+ ")}`));
		return selectBodyLines(lines);
	}

	// --- web_search: prefer markdown rendering if the result looks like markdown ---
	if (ref === "web_search") {
		const result = auditResultString(audit);
		if (!result) return undefined;
		return selectBodyLines(maybeRenderMarkdown(result, width, deps) ?? wrapBody(result, width, deps));
	}

	// --- generic: render the result as text or markdown ---
	const result = auditResultString(audit);
	if (!result) return undefined;
	return selectBodyLines(maybeRenderMarkdown(result, width, deps) ?? wrapBody(result, width, deps));
}

function borderColor(audit: AuditEntry, deps: AuditRenderDeps): string {
	if (audit.success === false) return deps.fg("error", "│");
	if (audit.success === true) return deps.fg("success", "│");
	return deps.fg("dim", "│");
}

function borderBox(lines: string[], width: number, audit: AuditEntry, deps: AuditRenderDeps): string[] {
	if (width < 4) return lines;
	const innerWidth = width - 4;
	const topLeft = deps.fg("dim", "╭");
	const topRight = deps.fg("dim", "╮");
	const bottomLeft = deps.fg("dim", "╰");
	const bottomRight = deps.fg("dim", "╯");
	const horizontal = deps.fg("dim", "─");
	const titleLine = `${topLeft}${horizontal.repeat(width - 2)}${topRight}`;
	const bottomLine = `${bottomLeft}${horizontal.repeat(width - 2)}${bottomRight}`;
	const side = borderColor(audit, deps);
	const framed: string[] = [titleLine];
	for (const line of lines) {
		const text = deps.truncateToWidth(line, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - deps.visibleWidth(text)));
		framed.push(` ${side} ${text}${padding} ${side}`);
	}
	framed.push(bottomLine);
	return framed;
}

/** One-line summary for the collapsed cell body. */
export function renderAuditSummary(audits: AuditEntry[], deps: AuditRenderDeps): string {
	if (audits.length === 0 || !deps.showAudits) return "";
	const titles = audits.map((audit) => {
		const raw = auditTitle(audit, deps).replace(/\x1b\[[0-9;]*m/g, "");
		return raw;
	});
	const summary = `${audits.length} nested call${audits.length === 1 ? "" : "s"}: ${titles.join(" · ")}`;
	return deps.fg("dim", summary);
}

/** Full bordered or plain list for the expanded cell body. */
export function renderAuditDetails(audits: AuditEntry[], width: number, deps: AuditRenderDeps): string[] {
	if (audits.length === 0 || !deps.showAudits) return [];
	const lines: string[] = [];
	for (const audit of audits) {
		const title = auditTitle(audit, deps);
		const body = auditBody(audit, width - 4, deps);
		const boxLines = body ? [title, ...body] : [title];
		if (deps.borderBoxes) {
			lines.push(...borderBox(boxLines, width, audit, deps));
		} else {
			lines.push(title);
			for (const line of body ?? []) lines.push(`  ${line}`);
		}
	}
	return lines;
}
