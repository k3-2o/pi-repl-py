// --- execute tool: the model-facing contract, shaped exactly like pi's built-in tools ---
// description = rich short behavior; promptSnippet = one-liner; guidelines = flat bullets.

export const executeToolDescription =
	"Execute Python in a Jupyter notebook. Your workspace is one notebook where every cell runs in a " +
	"shared Python environment: variables, functions, imports, classes, and data defined in one cell " +
	"stay available to later cells for the life of the notebook. Cells return their last expression " +
	"(auto-displayed) plus stdout/stderr; output is truncated to 45K with a marker.";

export const executePromptSnippet = "Run Python cells in a Jupyter notebook (read, write, run, search, and more)";

// --- the model-facing guidelines, flat bullets like pi's own tool contributions ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"Write modern idiomatic Python.",
		"Find, filter, fetch, sample: narrow the output in Python, then print only the window that decides the next step (a head, a shape, a slice), not the whole.",
		"Make surgical, precise changes over rewrites or whole-file dumps: a small unique anchor, replace, verify, read the file back before trusting it.",
		"Prefer to reuse existing variables, functions, imports, classes, and data from prior cells/namespaces over recomputing.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt and the notebook was restored from the last snapshot; reverify surviving names before building on them.",
		...(preloaded.length
			? [
					[
						"Preloaded helpers, use them as any loaded function or variable:",
						...preloaded.map((line) => `  - ${line.replace(/\n/g, "\n    ")}`),
					].join("\n"),
				]
			: []),
		"Be concise.",
	];
}
