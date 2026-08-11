// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---

export const executeToolDescription =
	"Execute Python in a persistent REPL — the session's working memory, notebook-style. Variables, imports, " +
	"and defs survive across cells. Shell and file IO are ordinary Python: `!cmd` / `%%bash` run shell, and " +
	"`open()` / `pathlib.Path` read and write files — no helper needed. Any preloaded helpers you add are " +
	"listed by `ls()`; `help(name)` shows what one's for. Wrap recurring chains into your own reusable " +
	"functions — they become part of your session workspace. A cell returns its final expression; anything " +
	"else prints. Runs in the project-local venv, so a command that starts python or pip must target that venv.";

export const executePromptSnippet =
	"Execute Python in a persistent REPL (notebook): state survives across cells, `!` runs shell, magics " +
	"work. Shell and file IO are ordinary Python; your own defs persist and are reusable. `ls()` lists your " +
	"workspace, `help(name)` shows usage.";

// --- the workspace doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## This workspace is persistent",
		"Everything you define — variables, imports, functions — survives across the whole session. " +
			"If a value, file, or function is already loaded, reuse it. Don't re-read an unchanged file or " +
			"re-derive a value just because it is earlier in the transcript.",
		"",
		"## Shell & files are plain Python",
		"`!cmd` runs a shell command fire-and-forget; `%%bash` runs a shell cell. Use `subprocess.run(...)` " +
			"when you need the result back in a variable. File IO is `open(...)` / `pathlib.Path` — read, " +
			"transform, write. There is no special helper to learn.",
		"",
		...(preloaded.length
			? ["## Your helpers", ...preloaded, "ls() lists them, help(name) shows what one's for.", ""]
			: []),
		"## Compose, then crystallize",
		"Start with direct calls. If the same chain appears more than once, wrap it in a `def` and call it " +
			"by arguments. One-off logic: run the cell. Recurring shape: a quick function. Frequent or complex " +
			"shape: a polished reusable function that composes other helpers and your own code.",
		"",
		"## Efficiency",
		"Printing is a context cost: everything a cell prints stays in the transcript for the whole turn. " +
			"Print slices, counts, and names — never whole files or dumps. Keep large values in variables. " +
			"End a cell with `;` to suppress the last-expression echo. For deep searches, use shell tools " +
			"(`fd`, `rg`, `du`, `grep`) instead of Python loops.",
		"",
		"## Guards",
		"Give long installs/builds a generous timeout. If the output starts with `<repl_engine_reset>`, the " +
			"kernel was rebuilt: your defs and imports are gone — recreate only what you need and re-verify " +
			"variables before trusting them.",
	];
}
