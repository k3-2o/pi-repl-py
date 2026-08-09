/**
 * The `execute` tool's prompt surface.
 *
 * pi's default system prompt is used as-is; all REPL knowledge rides on the
 * tool via these fields. Splitting them out keeps index.ts thin and the copy
 * reviewable in one place.
 *
 *  - description      — working summary / how it works (schema card text).
 *  - promptSnippet    — one line that lands in the default `Available tools`.
 *  - promptGuidelines — the detailed home: function map + doctrine + safety.
 *
 * The function map is NOT hard-coded here: it is derived from the toolbox
 * source via buildToolboxMap() (function_description docstring + def-signature
 * regex), so it always matches what the kernel actually loads.
 */

import { buildToolboxMap } from "./toolbox.js";

export const EXECUTE_DESCRIPTION =
	"Execute Python in a persistent evaluator — the session's working memory. " +
	"Variables, imports, functions, and data survive across calls, so work compounds. " +
	"There are no separate file or shell tools here: reading, writing, editing, and " +
	"running commands are done by calling Python functions inside a cell. " +
	"A cell returns the value of its final expression; anything else is printed. " +
	"Functions you define become reusable tools just like the prebuilt ones: call " +
	"them again instead of redefining, or combine existing functions into new " +
	"composed tools (a new def overwrites the previous one). " +
	"The evaluator runs in a project-local venv, so a command that starts python/pip " +
	"should target the same venv.";

export const EXECUTE_PROMPT_SNIPPET =
	"Execute Python in a persistent evaluator whose variables, imports, and functions " +
	"survive across calls — preloaded functions plus any you define and reuse as " +
	"callable tools; ls() lists them, help(name) shows usage";

/**
 * The promptGuidelines for the execute tool. `toolboxDir` is passed through so a
 * custom toolbox folder is reflected; unspecified defaults to the shipped one.
 */
export function buildExecutePromptGuidelines(toolboxDir?: string): string[] {
	const map = buildToolboxMap(toolboxDir);
	const functions = map.length > 0 ? map : ["(none preloaded — define your own functions with def())"];
	return [
		"You are not limited to a fixed set: the evaluator holds ordinary Python functions and you can define new ones that live for the session, or rework existing ones. The ones already loaded:",
		...functions,
		"ls() lists everything currently loaded; help(name) returns the exact signature and argument notes — use them instead of guessing.",
		// Define, reuse, rebuild — functions are reusable tools.
		"Reuse what you already defined: functions and variables persist for the whole session, so call them again with new arguments instead of rewriting them. Redefine only to fix a bug or change behavior — a new def overwrites the old one.",
		"Functions you create are first-class reusable tools, just like the preloaded ones. Make new functions as tools you will call again, combine several existing functions into one composite mega-tool, or modify an existing function to your exact spec. They compose:",
		"def count_hits(dir, pattern):\n    files = bash(f'grep -rl {pattern} {dir}').stdout.splitlines()\n    return sum(read(p).count(pattern) for p in files)",
		"Once defined, call your tools exactly like the preloaded ones — build composites so the next call builds on the previous result.",
		// Token efficiency / search.
		"Be token-efficient: context is finite, spend it only on what advances the answer. Filter precisely — scope reads to the lines you need and use bash('grep ...')/find instead of dumping whole files, so search does not bloat the context window.",
		"Keep large values in variables rather than printing them; a cell shows nothing unless you return or print it, so emit only the output that matters. Reuse what you already hold instead of recomputing or re-reading it.",
		// Safety.
		"If the output begins with <rlm_engine_reset>, the evaluator was rebuilt from a snapshot and may be stale — re-verify any variable before trusting it. Do not install packages into the evaluator; the standard library is always available. Run out-of-tree projects through their own environment.",
	];
}
