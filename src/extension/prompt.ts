/**
 * The system prompt (minimal spine + dynamic toolbox).
 *
 * Replaces pi's default coding-assistant prompt rather than appending to it.
 * It is deliberately lean: identity + environment + transparency, with the
 * toolbox surface assembled at session start from each function's own
 * docstring (one source of truth), so the list the model sees always matches
 * the code loaded into the kernel — nothing static to drift.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RlmPromptOptions {
	cwd: string;
	messagesPath?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	/** Explicit toolbox directory; defaults to the repo's src/engine/toolbox. */
	toolboxDir?: string;
}

interface ToolEntry {
	name: string;
	call: string; // e.g. "read(path)"
	description: string; // e.g. "return the text of a file"
}

/** Parse a toolbox file's opening docstring: "signature — what it does". */
function parseDocstringLead(source: string): { call: string; description: string } | null {
	const lead = source.match(/^"""\s*([^\n]+)/)?.[1];
	if (!lead) return null;
	const line = lead.trim().replace(/"""$/, "").trim();
	if (!line) return null;
	// Split on the em-dash (or " - ") common to our toolbox docstrings.
	const i = line.search(/\s+[—\-]\s+/);
	if (i === -1) return { call: line, description: "" };
	return {
		call: line.slice(0, i).trim(),
		description: line
			.slice(i)
			.replace(/^\s*[—\-]\s+/, "")
			.trim(),
	};
}

/** Load toolbox entries from a directory of one-function-per-*.py files. */
function loadToolboxEntries(dir?: string): ToolEntry[] {
	const d = dir && dir.length > 0 ? dir : join(import.meta.dirname, "..", "..", "src", "engine", "toolbox");
	if (!existsSync(d)) return [];
	const entries: ToolEntry[] = [];
	for (const file of readdirSync(d).sort()) {
		if (!file.endsWith(".py")) continue;
		const name = file.slice(0, -3);
		if (!/^[A-Za-z_]\w*$/.test(name)) continue;
		try {
			const parsed = parseDocstringLead(readFileSync(join(d, file), "utf8"));
			if (parsed) entries.push({ name, ...parsed });
		} catch {
			continue;
		}
	}
	return entries;
}

/** Build a short, comma-joined "call(...)" listing for the tool description. */
export function buildToolboxListing(dir?: string): string {
	return loadToolboxEntries(dir)
		.map((t) => t.call)
		.join(", ");
}

const EXAMPLES = [
	'      content = read("config.yaml")',
	'      result  = bash("pytest -q")',
	"      if result.returncode == 0:",
	'          write("test/summary.txt", result.stdout)',
];

function renderToolbox(tools: ToolEntry[]): string {
	const width = Math.max(...tools.map((t) => t.call.length), 0) + 2;
	const list = tools.map((t) => (t.description ? `      ${t.call.padEnd(width)}${t.description}` : `      ${t.call}`));
	return [
		"TOOLBOX",
		"- A set of functions is already imported and ready to call — reading, writing,",
		"  and editing files, running commands. They return ordinary Python values you",
		"  can assign, combine, and reuse.",
		"",
		...list,
		"",
		...EXAMPLES,
		"",
		"- This set is a foundation, not a ceiling. When it helps, define your own helpers",
		"  and compose these functions into reusable routines, so a job is done once",
		"  instead of repeated.",
		"- ls() lists what is available here; help(name) shows any function's exact call.",
	].join("\n");
}

const ENVIRONMENT = [
	"ENVIRONMENT",
	"- The evaluator is your working memory. Keep intermediate results in variables",
	"  and build on them rather than recomputing or re-reading.",
	"- Do the smallest amount of work that gives a correct answer. Batch related steps,",
	"  reuse what you already hold, and prefer one composed operation over several",
	"  scattered ones. Fewer round-trips is faster and cheaper.",
	"- bash(command) runs a shell in a fresh subshell and returns a CompletedProcess;",
	"  branch on its .returncode and read its .stdout/.stderr. State does not carry",
	"  between shell calls — hold it in Python variables instead.",
	"- The standard library is always available. Do not install packages into the",
	"  evaluator; run out-of-tree projects through their own environment and treat that",
	"  environment's results and failures as authoritative.",
].join("\n");

const TRANSPARENCY = [
	"TRANSPARENCY",
	"- A cell shows nothing unless you print or return it. Keep large values in variables",
	"  rather than flooding output.",
	"- If output begins with <rlm_engine_reset>, the environment was restored from a",
	"  snapshot and may be behind: re-verify any variable before you trust it.",
	"- External systems are reviewed through their own interface; the evaluator",
	"  coordinates and analyzes — it is not the home for their state.",
].join("\n");

export function buildRlmPyPrompt(options: RlmPromptOptions): string {
	const tools = loadToolboxEntries(options.toolboxDir);
	const parts = [
		"You are a Technical AI Assistant. Your only interface is execute — a persistent",
		"Python environment that keeps your variables, functions, imports, and data alive",
		"across every call. Work as a rigorous engineer: write code, run it, read the result,",
		"correct, and stop when the task is genuinely done.",
		"",
		ENVIRONMENT,
		"",
		renderToolbox(tools),
		"",
		TRANSPARENCY,
	];

	// Footer facts change with the session; keeping them last preserves prompt-cache
	// stability for the constant spine above.
	parts.push("", `Current working directory: ${options.cwd.replace(/\\/g, "/")}`);
	if (options.contextFiles && options.contextFiles.length > 0) {
		parts.push("", "<project_context>", "", "Project-specific instructions and guidelines:", "");
		for (const { path, content } of options.contextFiles) {
			parts.push(`<project_instructions path="${path}">`, content, "</project_instructions>", "");
		}
		parts.push("</project_context>");
	}

	return parts.join("\n");
}
