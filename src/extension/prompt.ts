export const executeToolDescription =
	"Execute Python in a Jupyter notebook. Your workspace is one notebook where every cell runs in a " +
	"shared Python environment: variables, functions, imports, classes, and data defined in one cell " +
	"stay available to later cells for the life of the notebook. Cells return their last expression " +
	"(auto-displayed) plus stdout/stderr; output is truncated to 45K with a marker.";

export const executePromptSnippet = "Run Python cells in a Jupyter notebook (read, write, run, search, and more)";

// --- the concrete helper list is NOT here: the tool guidelines are static, sessions vary, so the roster is per-session and spliced into the system prompt ---
export function buildPromptGuidelines(): string[] {
	return [
		"Write modern idiomatic Python.",
		"Find, filter, fetch, sample: narrow the output in Python, then print only the window that decides the next step (a head, a shape, a slice), not the whole.",
		"Make surgical, precise changes over rewrites or whole-file dumps: replace, verify, read the file back before trusting it.",
		"Prefer to reuse existing variables, functions, imports, classes, and data from prior cells/namespaces over recomputing.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt and the notebook was restored from the last snapshot; reverify surviving names before building on them.",
		"Helpers may be preloaded into the workspace (project .pi/helpers/ up to the git root, then the global ~/.pi/agent/pi-repl/helpers/, project shadowing global); the per-session list is stated in the system prompt. If output begins with <repl_helpers_failed>, those helpers failed to load at boot — do not call the listed names.",
		"Be concise.",
	];
}
