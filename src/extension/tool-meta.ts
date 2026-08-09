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
	"composed tools (a new def overwrites the previous one). Build ONE " +
	"parameterized function per shape (inputs become arguments) and reuse it by " +
	"args each time — never rebuild or duplicate it; extend the existing def, don't " +
	"fork a near-copy. " +
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
		// ── Define, reuse, rebuild: a function is a reusable tool you call by args ──
		"A function you define is a reusable tool that lives for the whole session. Build ONE parameterized function per shape (every input you vary becomes an argument) and call it by args each time. Never write the same routine more than once, never fork a near-duplicate, and never rewrite a body you already defined — extend the existing `def` instead.",
		"Decision rule before ANY multi-line cell: will I run this shape again with different inputs (a fetch, a file scan, a search, a report)? If yes or maybe, define the function NOW, with the varying inputs as arguments — so every later request is a one-line call, and it's answerable without repasting.",
		"Good — one tool, many args you only vary:",
		"def fetch_news(query, hl='en', gl='US', ceid='US:en', limit=15):\n    ...rss fetch + parse to a list of dicts...\n# later, each ask is just args:\nfetch_news('Turkey')\nfetch_news('Nigeria', hl='en-NG')\nfetch_news('oil', limit=6)",
		"Bad — forking near-duplicates instead of parameterizing (fetch_news vs fetch_news_region). Consolidate into the one def, superseding the old; a new def with the same name overwrites.",
		"Other reusable tool shapes build the same way:",
		"def find_files(pred, root='.') -> list[str]:\n    return [os.path.join(d,f) for d,_,fs in os.walk(root) for f in fs if glob.fnmatch(f, pred)]\n# then: find_files('*.csv'); find_files('*.py', root='src')\ndef count_lines(paths): ...\ndef summarize_csv(...): ...\n# compose them: report = count_lines(find_files('*.csv'))",
		"Functions compose and are first-class, just like the preloaded ones — make a mega-tool that calls your other tools, and modify an existing one to your exact spec instead of working around it.",
		"Keep each tool small and its inputs/return obvious; ls() lists them, help(name) shows the signature and docstring.",
		// ── Token efficiency: output is context forever ──
		"Be strictly token-efficient: EVERYTHING a cell prints or returns is carried in the session context for the rest of the turn, and later calls keep paying. A gigantic printed dump (a file, a directory tree, 100 search rows) bloat-context every request that follows.",
		"Reading & search are the highest-risk: scope reads to the slice you actually need (read(path, offset, limit)), and grep/search by pattern so you emit only the matching lines — then print counts/tags, not whole blobs, and hold the full object in a variable you index into later.",
		"Keep large values in variables rather than printing them; a cell shows nothing unless you return or print it, so emit only what moves the answer forward. Reuse what you already hold instead of recomputing or re-reading.",
		// Safety.
		"If the output begins with <rlm_engine_reset>, the evaluator was rebuilt from a snapshot: plain values are restored, but the temporary functions you defined are GONE. Recreate any helpers you need before using them, and re-verify a variable before trusting it.",
		"Do not install packages into the evaluator; the standard library is always available. Run out-of-tree projects through their own environment.",
	];
}
