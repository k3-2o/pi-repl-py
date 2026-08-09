// --- prompt: the execute tool's model-facing contract (pure, no pi/toolbox dependency) ---
// --- mirrors pi-robust-edit's schema/domain split: content lives here; the thin adapter in tool-meta wires it in ---

export const executeToolDescription =
	"Execute Python in a persistent evaluator — the session's working memory. Variables, imports, " +
	"functions, and data survive across every call. read, write, edit, and bash are Python functions " +
	"available in every cell, not separate tools. A cell returns its final expression; anything else " +
	"prints. Runs in the project-local venv, so a command that starts python or pip must target that venv.";

export const executePromptSnippet =
	"Execute Python in a persistent evaluator whose variables, imports, and functions survive across " +
	"calls; read/write/edit/bash are Python functions in every cell, plus anything you define and reuse; " +
	"ls() lists them, help(name) shows usage";

// --- the function doctrine riding the execute tool; sections keep every rule findable and rankable as hard or soft ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## What's in every cell",
		...preloaded,
		"Not sure what's available? Call ls() first; help(name) shows a signature and notes.",
		"",
		"## How to use them",
		"These are your file and shell tools — call them. Don't reimplement read/write/edit/bash in Python, " +
			"and don't fork a near-copy under a new name; a new def overwrites an old one by name, so extend " +
			"the existing function instead.",
		"Define a new function only to reuse it: if you'll run this shape again with different inputs, write " +
			"it once as def and call it by arguments — otherwise just run the cell.",
		"Do the job, then answer with the result. Don't tell the user you 'defined a function' or 'built a " +
			"tool'; that's internal machinery.",
		"",
		"## Examples",
		"Good — defined once, called by arguments:",
		"  def fetch_news(query, hl='en', gl='US', limit=15): <fetch + parse to a list>",
		"  fetch_news('Turkey')",
		"  fetch_news('Nigeria', hl='en-NG')",
		"Compose them:",
		"  def find_files(pattern, root='.'): <walk root, filter by pattern>",
		"  def count_lines(paths): ...",
		"  count_lines(find_files('*.csv'))      # one call",
		"",
		"## Efficiency",
		"Everything a cell prints stays in context for the whole turn, so print slices, matches, or counts — " +
			"never whole files — and keep large values in variables.",
		"For whole-filesystem or large-directory scans, use the shell tools (find, fd, du, grep), not a " +
			"Python os.walk: it pays a syscall per file and runs minutes on a big tree. Example: " +
			"`find -xdev -type f -size +100M | sort -rn | head`. Reserve Python for analysing the results.",
		"",
		"## When it breaks",
		"If the output starts with <rlm_engine_reset>, the kernel was rebuilt: data is restored but your " +
			"functions are gone — recreate any helper you need and re-verify a variable before trusting it.",
		"The standard library is available; don't install packages into the evaluator. Run out-of-tree " +
			"projects through their own environment.",
	];
}
