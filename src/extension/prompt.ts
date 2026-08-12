// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---
//
// Verbatim clauses from CodeAct (arXiv 2402.01030) and RLM (arXiv 2512.24601)
// are trimmed to what pi-repl actually has — no sub-LLMs, no recursion, no
// context variable — and the rest is stripped for lean context. Less prose,
// more signal; the machine reads every line every turn.

export const executeToolDescription =
	"You have one tool: a persistent Python workspace backed by a real `ipython` kernel. " +
	"Variables, imports, and definitions survive across cells and turns — it is your working memory and action " +
	"language. " +
	"Helpers in `~/.pi/agent/pi-repl/helpers/` load at boot; list them with " +
	"`[k for k in globals() if not k.startswith('_')]`. A cell returns its final expression; printed output is " +
	"captured separately.";

export const executePromptSnippet =
	"Work in the workspace: keep artifacts in variables, compose related actions in Python, print only what " +
	"the next step needs, and revise from what you observe.";

// --- the workspace doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## Your only workspace",
		"`execute` is the only callable tool. Python replaces a read, shell, search, and edit tool rack. State " +
			"persists across cells and turns.",
		"",
		"## Work in the workspace, not the transcript",
		"Load files, command results, search hits, and computed artifacts into variables once; filter, compare, " +
			"branch, edit, and verify them in later cells. Do not re-read or paste raw material back. Print only the " +
			"small observation needed for the next decision; keep the full artifact in a variable.",
		"",
		"## A cell is a small program",
		"Compose filesystem access, shell commands, searches, transforms, checks, and edits in ordinary Python " +
			"when they belong to the same step.",
		"",
		"## Revise on observations",
		"Revise prior actions or emit new actions upon new observations.", // CodeAct core
		"",
		"## Probe, then build",
		"Inspect what is present — count, print a few lines, list what is loaded — before committing. Build one " +
			"step, run it, and use its output to choose the next.",
		"",
		"## Batch and print sparingly",
		"Batch as much independent work as reasonably possible into one call. Keep large values in variables; " +
			"print slices, counts, and summaries.",
		"",
		...(preloaded.length
			? [
					"## Helpers",
					"User helpers load from `~/.pi/agent/pi-repl/helpers/` as workspace definitions. Their descriptions " +
						"appear below. List what is loaded with `[k for k in globals() if not k.startswith('_')]`.",
					"",
					...preloaded,
					"",
				]
			: []),
		"## Shell and search",
		"`subprocess.run(..., timeout=...)` when you need a result — always set a `timeout`, the evaluator does not " +
			"kill a silent cell. Use `rg`/`grep`/`find` via `subprocess.run` for deep searches, not Python loops.",
		"",
		"## Environment boundary",
		"The evaluator runs in a project-local venv, not the system Python. Do not install a target project's " +
			"dependencies into the evaluator. Run external projects through their own interface and normal commands.",
		"",
		"## Engine reset guard",
		"If output begins with `<repl_engine_reset>`, the kernel was rebuilt from the last snapshot. Re-verify a " +
			"revived variable before reusing it — especially in a shell command. Functions, classes, and live handles " +
			"are not snapshotted and must be redefined.",
	];
}
