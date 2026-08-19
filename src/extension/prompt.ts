// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---
//
// Verbatim clauses from CodeAct (arXiv 2402.01030) and RLM (arXiv 2512.24601)
// are trimmed to what pi-repl actually has — no sub-LLMs, no recursion, no
// context variable — and the rest is stripped for lean context. Less prose,
// more signal; the machine reads every line every turn.

export const executeToolDescription =
	"Execute Python cells in a persistent ipython kernel; state survives across cells and turns and " +
	"replaces the default read, bash, edit, write, and search tools. Let a cell's returned result prove " +
	"the work — hold artifacts in variables, print only the small slice the next decision needs, never " +
	"dump a whole file or raw result list.";

export const executePromptSnippet =
	"Execute Python cells in a persistent ipython kernel (replaces read, bash, edit, write, and search; state survives across cells and turns)";

// --- the workspace doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## Your only workspace",
		"`execute` is your workspace: a persistent Python session that is the only callable surface. What you define — variables, functions, data — survives across cells and turns, and the work is proven by the result each cell returns.",
		"",
		"## Let the result prove the work",
		"Work happens in the cell and is proven by its returned result — not by restating it in prose. Hold artifacts in variables; print only the small observation you'll decide on next. A bare final expression is auto-printed, so assign instead. Reading whole is fine when the task needs all of it: hold the whole and reason on it, don't re-fetch it.",
		"",
		"## A cell is a small program",
		"Compose filesystem access, shell commands, searches, transforms, checks, and edits in ordinary Python in the same step — and name what recurs: a step seen twice becomes a function that is already-proven work.",
		"",
		"## Revise on observations",
		"Revise prior actions or emit new actions upon new observations.", // CodeAct core
		"",
		"## Probe, then build",
		"Inspect what is present — count, print a few lines — before committing; build one step, run it, and let its returned result name the next.",
		"",
		"## File and search work",
		"Prefer a surgical old-text/new-text replacement over rewriting a file: read the region first, fix an exact unique anchor that appears once, replace exactly, then verify. After an edit errors or writes partial, read the file back from disk before reasoning on it. Complete writes only for new files or full rewrites. When walking directories, prune generated dirs and never print a raw tree.",
		"",
		"## Repository discipline",
		"Make the smallest valid change, preserve conventions, verify afterward, and never invent files, APIs, conventions, or test results.",
		"",
		"## Context is proof too",
		"Every printed value enters the context. The slice you print is evidence, not decoration: print only what the next decision consumes, and let the result you return be the certificate of the work.",
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
		"Always pass a `timeout` to `subprocess.run(...)` — a silent cell must die, not hang. Capture the result in a variable and read a slice, not dump the whole stdout. Use `rg`/`grep`/`find` for deep searches, not Python loops.",
		"",
		"## Environment & rescue",
		"The evaluator runs in a project-local venv, not the system Python. Do not install a project's dependencies into the evaluator; run external projects through their own interface. If output begins with `<repl_engine_reset>`, the kernel was rebuilt — re-verify any revived variable before reusing it.",
		"",
		"## One principle over the manual",
		"The rules above are working forms of one principle: work happens in the workspace and proves itself by the returned result — the transcript holds only what you act on. When a case isn't covered, apply the principle, not the rote rule.",
	];
}
