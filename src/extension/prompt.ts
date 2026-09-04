import { DEFAULT_MAX_OUTPUT_CHARS } from "../engine/index.js";

export const executeToolDescription =
	"Execute Python in a Jupyter notebook. Your workspace is one persistent live session: every " +
	"cell runs in the same namespace, so variables, functions, classes, imports, and data defined " +
	`in one cell stay available to every later cell. Output is truncated to ${DEFAULT_MAX_OUTPUT_CHARS} chars with an explicit marker`;

export const executePromptSnippet = "Execute Python in a Jupyter notebook (read, write, run, search, and more)";

export function buildPromptGuidelines(): string[] {
	return [
		"Write idiomatic Python.",
		"REPL-driven development: the live session's namespace is the single source of truth; reuse and extend existing objects rather than re-deriving them.",
		"Exploratory data analysis: look before acting (head, shape, slice, sample); print the minimal view that answers the question.",
		"Quit thinking and look: read the exact lines/values before changing anything.",
		"Minimal diff: change one thing at a time; if you didn't verify it, it ain't fixed.",
		"Idempotent cells: safe to re-run.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt from a snapshot; trust but verify surviving state.",
		"Be concise.",
	];
}
