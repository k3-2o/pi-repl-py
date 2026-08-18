// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---
//
// Verbatim clauses from CodeAct (arXiv 2402.01030) and RLM (arXiv 2512.24601)
// are trimmed to what pi-repl actually has — no sub-LLMs, no recursion, no
// context variable — and the rest is stripped for lean context. Less prose,
// more signal; the machine reads every line every turn.

export const executeToolDescription =
	"Execute Python cells in a persistent ipython kernel that stays alive across cells and turns. " +
	"It replaces the default read, bash, edit, write, and search tools — file work, shell commands, and " +
	"searches all run as Python. Everything you define (variables, imports, and helpers preloaded into the " +
	"workspace namespace) survives for reuse in later cells. A cell returns its final expression; printed " +
	"output is captured separately. Oversized output is truncated: 1,000,000 characters per cell, 4,096 per " +
	"line. Reads are expensive — every printed value enters the context, so hold artifacts in variables, " +
	"parse before printing, and print only the small bounded slice the next decision needs. Keep cells lean; " +
	"full-file dumps and raw result lists bloat the conversation.";

export const executePromptSnippet =
	"Execute Python cells in a persistent ipython kernel (replaces read, bash, edit, write, and search; state survives across cells and turns)";

// --- the workspace doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## Your only workspace",
		"`execute` is the only callable tool. Python replaces a read, shell, search, and edit tool rack. State persists across cells and turns.",
		"",
		"## Work in the workspace, not the transcript",
		"Load files, command results, searches, and computed artifacts into variables once; filter, compare, branch, edit, and verify them in later cells. Do not re-read or paste raw material back. Print only the small observation you'll decide on next; keep the full artifact in a variable. A bare final expression is auto-displayed by IPython — assign instead and print only what the next step needs.",
		"",
		"## A cell is a small program",
		"Compose filesystem access, shell commands, searches, transforms, checks, and edits in ordinary Python in the same step.",
		"",
		"## Revise on observations",
		"Revise prior actions or emit new actions upon new observations.", // CodeAct core
		"",
		"## Probe, then build",
		"Inspect what is present — count, print a few lines, list what is loaded — before committing; build one step, run it, and use its output to choose the next.",
		"",
		"## File and search work",
		"Prefer a surgical old-text/new-text replacement over rewriting a file: read the region first, make the smallest unique replacement, verify the change and file validity. Use complete writes only for new files or intentional full rewrites. When walking directories, prune generated dirs — node_modules, .git, .venv, dist, __pycache__ — and never print a raw tree.",
		"",
		"## Repository discipline",
		"Make the smallest valid change, preserve conventions, verify afterward, and never invent files, APIs, conventions, or test results.",
		"",
		"## Context is expensive",
		"Every printed value enters the conversation. Explore and filter in variables; print only the small, bounded slice for the next decision. Never dump a whole file, a raw result list, or an unbounded output, and never rely on truncation to control it.",
		"",
		...(preloaded.length
			? [
					"## Helpers",
					"These helpers are already defined in the workspace namespace. Use them by name as you would any other loaded function, class, or variable. Their code already executed at kernel boot. Descriptions appear below.",
					"",
					...preloaded,
					"",
				]
			: []),
		"## Shell and search",
		"Always pass a `timeout` to `subprocess.run(...)` — a silent cell must die, not hang. Use `rg`/`grep`/`find` via the subprocess for deep searches, not Python loops.",
		"",
		"## Environment & rescue",
		"The evaluator runs in a project-local venv, not the system Python. Do not install a project's dependencies into the evaluator; run external projects through their own interface. If output begins with `<repl_engine_reset>`, the kernel was rebuilt — re-verify any revived variable before reusing it.",
		"",
		"## Follow these as the operating manual",
		"These guidelines are how this workspace works — internalize their intent and adapt to this environment by applying it to decisions they do not spell out. Follow them diligently.",
	];
}
