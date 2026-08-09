/**
 * The `execute` tool's prompt surface.
 *
 * pi's default system prompt is used as-is; all REPL knowledge rides on the
 * tool via these fields, so index.ts stays thin.
 *
 *  - description   — working summary (schema card).
 *  - promptSnippet — one line in the default `Available tools`.
 *  - promptGuidelines — the function doctrine + tokens + safety.
 *
 * The function map is derived from the toolbox source via buildToolboxMap()
 * (function_description docstring + def-signature regex), so it always matches
 * what the kernel loads.
 */

import { buildToolboxMap } from "./toolbox.js";

export const EXECUTE_DESCRIPTION =
	"Execute Python to a persistent evaluator: the session's working memory. " +
	"Variables, imports, functions, and data survive across calls. There are no " +
	"separate file or shell tools; read, write, edit, bash, and anything you build " +
	"are Python functions you call inside a cell. The preloaded functions are the evaluator's standard file and shell surface, and the foundation you build your own reusable tools on. A cell returns its final " +
	"expression; anything else is printed. Build one reusable function per routine " +
	"and call it by arguments, since a new def overwrites the previous one; don't " +
	"narrate that machinery to the user. Runs in a project-local venv, so a command " +
	"that starts python or pip must target that venv.";

export const EXECUTE_PROMPT_SNIPPET =
	"Execute Python in a persistent evaluator whose variables, imports, and functions " +
	"survive across calls; the preloaded read/write/edit/bash are the standard file and shell surface, plus any you define and reuse as " +
	"callable tools; ls() lists them, help(name) shows usage";

/**
 * promptGuidelines for the execute tool. `toolboxDir` is optional; it defaults to
 * the shipped toolbox.
 */
export function buildExecutePromptGuidelines(toolboxDir?: string): string[] {
	const map = buildToolboxMap(toolboxDir);
	const preloaded = map.length > 0 ? map : ["(none preloaded: define your own)"];
	return [
		"Preloaded functions available in every cell:",
		...preloaded,
		"These are the evaluator's standard file and shell surface, its own read/write/edit/bash builtins; treat them as the natural idiom for file and command work.",
		"Build on them: compose your own useful tools from and around these functions rather than rebuilding them; anything you define this session joins the same surface. ls() lists what's loaded, help(name) shows signatures and notes.",
		"Functions you define are reusable tools: one parameterized helper per task, call it by arguments. Never write a routine twice and never fork a duplicate; extend the existing `def` (a new `def` of the same name overwrites).",
		"Before a multi-line cell, ask whether you will run that shape again with different inputs. If yes, define the function now so each later request is one call.",
		"Good, defined once then called by arguments only:",
		"def fetch_news(query, hl='en', gl='US', ceid='US:en', limit=15):\n    <fetch + parse to a list>\nfetch_news('Turkey')\nfetch_news('Nigeria', hl='en-NG')",
		"Don't build a near-copy (avoid fetch_news and fetch_news_region); add the varying bits to the original `def` and let it supersede the old.",
		"Other reusable shapes build the same way:",
		"def find_files(pred, root='.'):\n    <walk root, filter by pred>\nfind_files('*.csv')\nfind_files('*.py', root='src')\ndef count_lines(paths): ... # compose: count_lines(find_files('*.csv'))",
		"Use functions proportionally: build one when it will be reused, otherwise run it in a plain cell. Don't wrap a one-off and don't over-engineer.",
		"Never narrate your mechanism to the user (don't say 'I defined a function' or 'I built a tool'). Do the job, then answer with the result.",
		"Be token efficient: everything a cell prints is context for the rest of the turn. When reading or searching, print slices, matches, or counts rather than whole files, and keep large values in variables.",
		"For whole-filesystem or large-dir scans, use the kernel's tools via bash, not a Python walk: find, du, fd, grep. Chain them (find -xdev -type f -size +100M | sort -rn | head; du -x | sort -h | tail) and prune descent by skipping node_modules, .git, caches, venvs. A Python os.walk + lstat loop pays a slow syscall per file and runs minutes to 10+ min on a big tree; reserve Python for analysing the results, not for enumerating the disk.",
		"If the output starts with <rlm_engine_reset>, the kernel was rebuilt: only data is restored, your functions are gone. Recreate any helper you need and re-verify a variable before trusting it.",
		"Don't install packages into the evaluator; the standard library is available. Run out-of-tree projects through their own environment.",
	];
}
