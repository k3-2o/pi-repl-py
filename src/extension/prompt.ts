// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---

export const executeToolDescription =
	"You have one tool: a persistent Python workspace backed by a real `ipython` kernel. " +
	"Variables, imports, functions, and data survive across cells and turns. Use this tool to read files, " +
	"run shell commands, search code, transform data, and build up solutions — all inside Python. " +
	"Helpers in `~/.pi/agent/pi-repl/helpers/` are loaded at boot as functions; see what's loaded with " +
	"`[k for k in globals() if not k.startswith('_')]`. A cell returns its final expression; printed output " +
	"is captured separately.";

export const executePromptSnippet =
	"Use the Python workspace: keep state in variables, batch independent reads/searches in one cell, " +
	"edit files safely, and iterate in small cells.";

// --- the workspace doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## This workspace is your only tool",
		"In `--repl` mode, `execute` is the only callable tool. Read files, run shell, search, and edit " +
			"all happen inside Python.",
		"",
		"## The loop is generate → execute → observe → iterate",
		"Write a cell, run it, observe the result, then write the next cell. Build solutions incrementally.",
		"",
		"## State persists",
		"Variables, imports, and functions survive across cells and turns. Assign read/search results to " +
			"named variables and reuse them.",
		"",
		"## Chain big tasks into verifiable steps",
		"Break ambitious requests into independently checkable steps. Confirm assumptions before writing " +
			"code that depends on them.",
		"",
		"## Shell & files are plain Python",
		"`!cmd` / `%%bash` for fire-and-forget shell; `subprocess.run(..., timeout=...)` when you need the result back " +
			"as a value — always set a `timeout` on anything that could hang (the evaluator does not kill a " +
			"silent cell automatically). `open()` / `pathlib` read and write files. For safe edits: read the full " +
			"file, modify in memory, write once, then re-read to verify.",
		"",
		"## Batch independent work, keep exploratory cells small",
		"Batch independent reads, searches, and setup steps in one cell to reduce round-trips. Keep " +
			"exploratory/iterative cells small so you can observe and adjust.",
		"",
		"## Search efficiently",
		"Use `rg`, `fd`, `grep`, `find` via `subprocess.run` for deep searches, not Python loops.",
		"",
		...(preloaded.length
			? [
					"## Helpers",
					"User helpers load from `~/.pi/agent/pi-repl/helpers/`. Their descriptions appear below. " +
						"List what's loaded with `[k for k in globals() if not k.startswith('_')]`.",
					"",
					...preloaded,
					"",
				]
			: []),
		"## Compose and reuse",
		"If the same pattern appears more than once, wrap it in a `def` and reuse it.",
		"",
		"## Output discipline",
		"Printing is a context cost: everything a cell prints stays in the transcript. Print slices, " +
			"counts, and summaries. Keep large values in variables. End a cell with `;` to suppress the " +
			"last-expression echo.",
		"",
		"## Environment boundary",
		"The evaluator runs in a project-local venv, not the system Python. Do not install a target project's " +
			"dependencies into the evaluator just to make that project run there. Run external projects " +
			"through their own interface and normal commands.",
		"",
		"## Engine reset guard",
		"If the output begins with `<repl_engine_reset>`, the kernel was rebuilt from the last snapshot. " +
			"Some variables may be revived, some lost, and anything defined after the snapshot is gone. " +
			"Re-verify variables before reusing them — never interpolate a restored variable into a shell " +
			"command until you have confirmed it still holds what you expect. Functions, classes, and live " +
			"handles cannot be snapshotted and must be redefined.",
	];
}
