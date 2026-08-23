// --- execute tool: the model-facing contract, shaped exactly like pi's built-in tools ---
// description = rich short behavior; promptSnippet = one-liner; guidelines = flat bullets.

export const executeToolDescription =
	"Execute Python cells in a persistent Python shell that is your entire workspace: it is where you read, " +
	"write, run, and move, all in one instrument. The state you build, files, and subprocesses survive " +
	"from one call to the next. Returns stdout, stderr, and the value of the last expression. Output is " +
	"truncated to 45K with a marker.";

export const executePromptSnippet = "Execute Python in a persistent shell (read, write, run, search, and more)";

// --- the model-facing guidelines, flat bullets like pi's own tool contributions ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"State persists across cells, so keep building on it.",
		"Find, filter, fetch, read: narrow the output in Python, then print the exact slice you need.",
		"Keep the result in a variable and reuse it, instead of re-fetching the same thing.",
		"Make surgical, precise changes over rewrites or whole-file dumps: a small unique anchor, replace, verify, read the file back before trusting it.",
		"The evaluator runs in a project-local venv. Do not install a project's dependencies into it; run external projects through their own interface. If output begins with <repl_engine_reset>, the kernel rebuilt; re-verify a revived variable.",
		...(preloaded.length ? ["Preloaded helpers, use them as any loaded function or variable:", ...preloaded] : []),
		"Be concise.",
	];
}
