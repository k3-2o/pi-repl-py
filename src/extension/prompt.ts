// --- prompt: the execute tool's model-facing contract (pure, no pi/helper dep) ---
// The description + snippet use a BROAD term ("helpers", "low-level blocks")
// rather than naming any Python type (no "context manager"/no "class"), so we can
// add more helper shapes later without rewriting the contract. The precise
// mechanics of each helper live in the guidelines, not here.

"and defs survive across cells; `!cmd` runs shell and the usual magics work. A few LOW-LEVEL helpers are " +
	"preloaded for the awkward bits (shell, edit, web) — building blocks that own only the hard part, not finished " +
	"tools; `ls()` lists them, `help(name)` shows what one's for. Wrap them into your OWN helpers when a " +
	"pattern recurs. File IO and scripting are ordinary Python. A cell returns its final expression; anything " +
	"else prints. Runs in the project-local venv, so a command that starts python or pip must target that venv.";

export const executePromptSnippet =
	"Execute Python in a persistent REPL (notebook): state survives across cells, `!` runs shell, magics " +
	"work, and a few low-level helpers are preloaded (`ls()` / `help(name)`). Wrap them into your own helpers " +
	"when a pattern recurs; file IO and scripting are ordinary Python";

// --- the helper doctrine riding the execute tool ---
export function buildPromptGuidelines(preloaded: string[]): string[] {
	return [
		"## What's in every cell",
		...preloaded,
		"Not sure what's available? Call ls() first; help(name) tells you what one is.",
		"",
		"## How to use them",
		"These are LOW-LEVEL helpers, not finished tools: each owns only a fragile or opaque part (safe shell " +
			"teardown, or a web endpoint you can't invent). The actual work happens in your code — the command, " +
			"arguments, parsing, and decisions are yours.",
		"Build your own tools: when the same shape recurs across cells (the same fetch, filter, or transform), " +
			"wrap it ONCE into your own function/helper and reuse it. ls() lists the helpers plus every function " +
			"you've defined — that list is your library. Reaching for an existing def beats rewriting its logic; " +
			"rewriting is the failure mode. A new def of the same name overwrites the old one, so extend the " +
			"existing helper rather than forking a near-copy.",
		"",
		"## Shell, files & editing",
		"File IO and scripting are plain Python — read & write with Path.read_text()/write_text(); don't wrap " +
			"them. The shell helper is a block (`with <shell>() as s:` then `s.run(cmd)`) that only handles the " +
			"shell plumbing; you decide the command and what the structured result (returncode/stdout/stderr) " +
			"means. The edit helper is a block too (`with edit(path) as ed:` then mutate `ed.text`) that only " +
			"handles a SAFE save (atomic write, .bak backup, stale-file abort) — you decide exactly what text to " +
			"change. A small in-place edit beats rewriting the whole file. `!cmd` runs a shell command " +
			"fire-and-forget; `%%bash`/`%timeit` and the other magics work.",
		"Set a timeout deliberately: pass a GENEROUS timeout to a helper for long-running installs or builds " +
			"(be patient), and a small one only when you know work is quick. The evaluator's own watchdog is the " +
			"backstop, not your policy.",
		"Define a function when a shape recurs; don't wrap a one-off call in a def — just run the cell.",
		"",
		"## Examples",
		"Good — define a recurring shape once, then call it by arguments:",
		"  def log_lines(since='-10'):\n      with shell() as s:\n          r = s.run('git log --oneline ' + since)\n" +
			"      return r.stdout.splitlines()",
		"  log_lines()",
		"  log_lines('-20')",
		"",
		"## Efficiency",
		"Context is the budget: everything a cell prints lands in the transcript for the whole turn. Print " +
			"slices, counts, or names — never whole files or dumps — and keep large values in variables. A `;` " +
			"at the end of a cell suppresses its last-expression echo.",
		"Search output is the classic bloat trap: the web helper returns long payloads. Store the result in a " +
			"variable, print a lean digest (titles + links, or hit counts), and pull the full text only when a " +
			"result looks relevant — never stream the whole content list.",
		"For whole-filesystem or large-directory scans, use the shell (find, du, grep) not a Python os.walk: it " +
			"pays a syscall per file and runs minutes on a big tree. Example: `find -xdev -type f -size +100M | " +
			"sort -rn | head`. Reserve Python for analysing the results.",
		"",
		"## When it breaks",
		"If the output starts with <rlm_engine_reset>, the kernel was rebuilt: data is restored but your " +
			"functions are gone — recreate any helper you need and re-verify a variable before trusting it.",
		"The standard library is available; don't install packages into the evaluator. Run out-of-tree projects " +
			"through their own environment.",
	];
}
