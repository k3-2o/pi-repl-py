import { DEFAULT_MAX_OUTPUT_CHARS } from "../engine/index.js";

export const executeToolDescription =
	"Execute Python in a Jupyter notebook. Your workspace is a notebook where every cell runs in a " +
	"shared Python environment: variables, functions, imports, classes, and data defined in one cell " +
	"stay available and reuseable for later cells for the life of the notebook. " +
	`Output is truncated to ${DEFAULT_MAX_OUTPUT_CHARS} chars with an explicit marker`;

export const executePromptSnippet = "Execute Python in a Jupyter notebook (read, write, run, search, and more)";

export function buildPromptGuidelines(): string[] {
	return [
		"Write idiomatic Python.",
		"Find, Filter, Fetch, Sample and Narrow down the output in Python, always print the exact (slice, snippet, Excerpt) you need. Be precise.",
		"Make surgical changes over rewrites or whole-file dumps: read the exact lines first, anchor them, then replace, verify and read the file back before trusting it.",
		"REUSE existing variables, functions, imports, classes, and data from prior cells/namespaces rather than recomputing or reconstructing states that already exist in the notebook.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt and the kernel was restored from a snapshot; reverify surviving states before building on them.",
		"Be concise.",
	];
}
