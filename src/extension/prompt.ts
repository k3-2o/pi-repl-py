export const executeToolDescription =
	"Execute Python in a Jupyter notebook. Your workspace is one notebook where every cell runs in a " +
	"shared Python environment: variables, functions, imports, classes, and data defined in one cell " +
	"stay available and reuseable for later cells for the life of the notebook. " +
	"Output is truncated to 45K with an explicit marker ([... output truncated at 46080 chars ...]).";

export const executePromptSnippet = "Run Python in a Jupyter notebook (read, write, run, search, and more)";

export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"Write modern idiomatic Python.",
		"Find, Filter, Fetch: narrow down the output in Python and only print the exact slice you'll ever need, be scrupulous.",
		"Make surgical, precise, atomic changes over rewrites or whole-file dumps: read the exact lines FIRST, anchor them, replace, verify, read the file back before trusting it",
		"AMORTIZE existing variables, functions, imports, classes, and data from prior cells/namespaces over re-deriving, recomputing or reconstructing.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt and the notebook was restored from a recent snapshot; reverify surviving states before building on them.",
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
