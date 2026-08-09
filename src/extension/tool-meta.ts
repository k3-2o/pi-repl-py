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
	"The evaluator runs in a project-local venv, so a command that starts python/pip " +
	"should target the same venv.";

export const EXECUTE_PROMPT_SNIPPET =
	"Execute Python in a persistent evaluator whose variables, imports, and functions " +
	"survive across calls — preloaded functions, plus any you define with def(); " +
	"ls() lists them, help(name) shows usage";

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
		// Define, reuse, rebuild.
		"Define and reuse: wrap repeated work in a function and call it by name. If a function is not good enough, rework it rather than working around it:",
		"def filter_warnings(paths, pattern, limit=10):\n    out = []\n    for p in paths:\n        for line in read(p).splitlines():\n            if pattern in line:\n                out.append((p, line))\n                if len(out) == limit:\n                    return out\n    return out",
		"Chain preloaded functions with your own so the next call builds on the previous one.",
		// Token efficiency / search.
		"Be token-efficient: context is finite, spend it only on what advances the answer. Filter precisely — scope reads to the lines you need and use bash('grep ...')/find instead of dumping whole files, so search does not bloat the context window.",
		"Keep large values in variables rather than printing them; a cell shows nothing unless you return or print it, so emit only the output that matters. Reuse what you already hold instead of recomputing or re-reading it.",
		// Safety.
		"If the output begins with <rlm_engine_reset>, the evaluator was rebuilt from a snapshot and may be stale — re-verify any variable before trusting it. Do not install packages into the evaluator; the standard library is always available. Run out-of-tree projects through their own environment.",
	];
}
