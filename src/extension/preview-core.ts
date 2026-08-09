/**
 * Semantic cell previews: the collapsed line of an \u0060execute\u0060 cell.
 *
 * A cell's first line is almost always plumbing (const out = await ...), so
 * "first non-comment line" renders every collapsed call as noise. This module
 * scores the whole cell for intent — the shell command inside a Bun.$ template,
 * the task handed to a subagent, the file a write lands on — and returns the
 * one line a reader would want, plus which kind of work it is.
 *
 * Pure and dependency-free so the scorer is table-testable; render-core
 * consumes it for the collapsed header.
 */

/** What kind of work the winning line represents; drives the header label. */
type CellPreviewKind = "shell" | "agent" | "ts";

export interface CellPreview {
	kind: CellPreviewKind;
	text: string;
}

const BACKTICK = "\u0060";
const DESCRIPTOR_MAX_WIDTH = 64;

//--- descriptor hygiene ---

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) return text;
	return text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd() + "…";
}

function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[=:]\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[=:]\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

export function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}

//--- source scanning ---

interface Span {
	start: number;
	end: number;
	body: string;
}

/**
 * Body of the template literal opening at start (the backtick index). Tracks
 * escapes and interpolation nesting (including nested templates) so a shell
 * command containing interpolations is captured whole. An unclosed template is
 * returned as-is: while args stream, previewing the partial command beats
 * previewing nothing.
 */
function scanTemplate(source: string, start: number): Span {
	let depth = 0;
	let inNested = false;
	for (let i = start + 1; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === BACKTICK) {
			if (depth === 0 && !inNested) return { start, end: i + 1, body: source.slice(start + 1, i) };
			inNested = !inNested;
			continue;
		}
		if (!inNested && ch === "$" && source[i + 1] === "{") {
			depth += 1;
			i += 1;
			continue;
		}
		if (!inNested && depth > 0 && ch === "}") depth -= 1;
	}
	return { start, end: source.length, body: source.slice(start + 1) };
}

const CONST_STRING_PATTERN = new RegExp(
	'(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:"([^"\\n]*)"|' +
		"'([^'\\n]*)'|" +
		BACKTICK +
		"([^" +
		BACKTICK +
		"$\\n]*)" +
		BACKTICK +
		")",
	"g",
);

/** Simple string constants, for resolving interpolations and path arguments. */
function stringConsts(source: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const match of source.matchAll(CONST_STRING_PATTERN)) {
		const name = match[1];
		const value = match[2] ?? match[3] ?? match[4];
		if (name && value !== undefined) vars.set(name, value);
	}
	return vars;
}

function substituteVars(text: string, vars: ReadonlyMap<string, string>): string {
	return text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) => vars.get(name) ?? whole);
}

function maskSpan(source: string, span: Span): string {
	return source.slice(0, span.start) + " ".repeat(span.end - span.start) + source.slice(span.end);
}

//--- shell command simplification ---

const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+?)\s*(?:&&|;)\s*/;
const SHELL_SETUP_PATTERN = /^(?:export\s+\w+=|set\s+[-+]|source\s+\S+|\.\s+\S+)/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

function shellWords(line: string): string[] {
	const words: string[] = [];
	for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function pathTail(path: string): string {
	const cleaned = path.replace(/\/+$/, "");
	const tail = cleaned.slice(cleaned.lastIndexOf("/") + 1);
	return tail || cleaned;
}

function simplifyRunnerCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words[0] === "npm" || words[0] === "pnpm") {
		const runIndex = words.indexOf("run");
		if (runIndex >= 0 && words[runIndex + 1]) {
			return (words[0] + " " + words.slice(runIndex + 1).join(" ")).trim();
		}
	}
	if (line.includes("node_modules/.bin/")) {
		return line.replace(/\S*node_modules\/\.bin\//g, "");
	}
	return undefined;
}

function simplifyMutationCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words.length === 0) return undefined;
	if (words[0] === "cat" && words[1] === ">" && words[2]) return "write " + pathTail(words[2]);
	if (words[0] === "tee" && words.at(-1)) {
		return (words.includes("-a") ? "append " : "write ") + pathTail(words.at(-1) ?? "");
	}
	return undefined;
}

function simplifyShellLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

/**
 * Commands that prepare the ground rather than do the work. A cell that mkdirs
 * and then writes a file is a write; the shell only wins when it is the story.
 */
const SHELL_SETUP_WORDS = new Set([
	"mkdir",
	"cd",
	"export",
	"touch",
	"chmod",
	"chown",
	"ln",
	"echo",
	"true",
	"sleep",
	"which",
	"sync",
]);

const SHELL_ACTION_WORDS = new Set([
	"rm",
	"mv",
	"cp",
	"git",
	"npm",
	"pnpm",
	"bun",
	"bunx",
	"npx",
	"make",
	"cargo",
	"docker",
	"curl",
	"gh",
	"pi",
]);

function shellLineScore(line: string, index: number): number {
	const simplified = simplifyShellLine(line);
	const words = shellWords(line);
	let score = 30;
	if (simplified !== line) score += 40;
	if (SHELL_ACTION_WORDS.has(words[0] ?? "")) score += 20;
	if (/\b(?:rm|mv|cp|git\s+(?:add|commit|push)|sed\s+-i|perl\s+-pi|tee|cat\s*>)\b/.test(line)) score += 40;
	return score + index;
}

function heredocBody(lines: readonly string[], startIndex: number, delimiter: string): string | undefined {
	const body: string[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === delimiter) return body.join("\n");
		body.push(lines[i] ?? "");
	}
	return body.length > 0 ? body.join("\n") : undefined;
}

function previewHeredoc(lines: readonly string[]): string | undefined {
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		const delimiter = line.match(HEREDOC_PATTERN)?.[1];
		if (!delimiter) continue;
		const body = heredocBody(lines, i, delimiter);
		if (!body) continue;
		// The write target is the story; the body is detail for the expanded view.
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) return (line.includes("tee -a") ? "append " : "write ") + pathTail(catWrite[1]);
		return descriptor(body);
	}
	return undefined;
}

/** Best single line of a (possibly multi-line, chained) shell command. */
export function previewShellCommand(command: string): string {
	return previewShellCommandScored(command).text;
}

/** As previewShellCommand, but keeps the winning line's own strength so a cell
 * with several shell calls can surface the strongest one. */
function previewShellCommandScored(command: string): { text: string; strength: number } {
	const lines = command.split("\n");
	const heredoc = previewHeredoc(lines);
	if (heredoc) return { text: descriptor(heredoc), strength: 90 };

	let best: { text: string; score: number } | undefined;
	let cwdSuffix: string | undefined;
	let index = 0;
	for (const rawLine of lines) {
		for (const rawPart of rawLine.split(/\s*(?:&&|;)\s*/)) {
			let part = rawPart.trim();
			if (!part || part.startsWith("#") || SHELL_SETUP_PATTERN.test(part)) continue;
			const cd = part.match(CD_PREFIX_PATTERN);
			if (cd?.[1]) {
				cwdSuffix = pathTail(cd[1].trim());
				part = part.replace(CD_PREFIX_PATTERN, "").trim();
			} else if (/^cd\s+\S+$/.test(part)) {
				cwdSuffix = pathTail(part.slice(2).trim());
				continue;
			}
			if (!part) continue;
			const candidate = { text: simplifyShellLine(part), score: shellLineScore(part, index) };
			if (!best || candidate.score > best.score) best = candidate;
			index += 1;
		}
	}
	if (!best) return { text: "", strength: 0 };
	// --- trailing redirections are plumbing, not intent ---
	const cleaned = best.text.replace(/(?:\s*(?:2>&1|[12]?>\s*\/dev\/null|&>\s*\/dev\/null))+\s*$/, "");
	// --- a stripped cd prefix still matters ---
	const text = cwdSuffix && !cleaned.includes(cwdSuffix) ? cleaned + " (" + cwdSuffix + ")" : cleaned;
	return { text: descriptor(text), strength: best.score };
}

//--- special construct extraction ---

interface Candidate {
	kind: CellPreviewKind;
	text: string;
	score: number;
}

const SHELL_OPEN_PATTERN = new RegExp("Bun\\s*\\.\\s*\\$\\s*(?:\\([^)]*\\)\\s*)?" + BACKTICK, "g");

function shellCandidates(
	source: string,
	vars: ReadonlyMap<string, string>,
): { candidates: Candidate[]; masked: string } {
	const candidates: Candidate[] = [];
	let masked = source;
	SHELL_OPEN_PATTERN.lastIndex = 0;
	let match = SHELL_OPEN_PATTERN.exec(masked);
	while (match) {
		const span = scanTemplate(masked, match.index + match[0].length - 1);
		const command = previewShellCommandScored(substituteVars(span.body, vars));
		// --- the command's own strength breaks ties; setup-only drops lower ---
		if (command.text) {
			const setupOnly = SHELL_SETUP_WORDS.has(shellWords(command.text)[0] ?? "");
			const score = setupOnly ? 72 : 90 + Math.min(command.strength, 200) / 25;
			candidates.push({ kind: "shell", text: command.text, score });
		}
		masked = maskSpan(masked, span);
		SHELL_OPEN_PATTERN.lastIndex = span.end;
		match = SHELL_OPEN_PATTERN.exec(masked);
	}
	return { candidates, masked };
}

const STRING_ARG_PATTERN = /^\s*(?:"([^"]*)"|'([^']*)')/;

function agentCandidates(
	source: string,
	vars: ReadonlyMap<string, string>,
): { candidates: Candidate[]; masked: string } {
	const tasks: string[] = [];
	let masked = source;
	const pattern = /rlm\s*\.\s*run\s*\(/g;
	let match = pattern.exec(masked);
	while (match) {
		const argsStart = match.index + match[0].length;
		let task: string | undefined;
		const rest = masked.slice(argsStart);
		const literal = rest.match(STRING_ARG_PATTERN);
		if (literal) {
			task = literal[1] ?? literal[2];
		} else if (rest.trimStart().startsWith(BACKTICK)) {
			const tickIndex = argsStart + rest.indexOf(BACKTICK);
			const span = scanTemplate(masked, tickIndex);
			task = substituteVars(span.body, vars);
			masked = maskSpan(masked, span);
		} else {
			const identifier = rest.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1];
			task = identifier ? (vars.get(identifier) ?? identifier) : undefined;
		}
		// --- a chosen child name is identity; lead with it ---
		const name = masked.slice(argsStart).match(/name\s*:\s*(?:"([^"]*)"|'([^']*)')/);
		const label = name?.[1] ?? name?.[2];
		tasks.push(label && task ? label + ": " + task : (label ?? task ?? "subagent"));
		pattern.lastIndex = argsStart;
		match = pattern.exec(masked);
	}
	const candidates: Candidate[] =
		tasks.length === 0
			? []
			: [
					{
						kind: "agent",
						text: descriptor(tasks.length === 1 ? (tasks[0] ?? "") : tasks[0] + " (+" + (tasks.length - 1) + " more)"),
						score: 100,
					},
				];
	return { candidates, masked };
}

const FILE_EFFECT_PATTERN =
	/(?:Bun\.write|\b(?:fs|fsp|promises)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|cp)|\b(?:writeFileSync|writeFile|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync))\s*\(\s*([^,)\n]+)/g;

const FILE_EFFECT_VERBS: ReadonlyArray<[string, string]> = [
	["Bun.write", "write"],
	["writeFileSync", "write"],
	["writeFile", "write"],
	["appendFileSync", "append"],
	["appendFile", "append"],
	["mkdirSync", "mkdir"],
	["mkdir", "mkdir"],
	["rmdirSync", "delete"],
	["rmSync", "delete"],
	["rm", "delete"],
	["unlinkSync", "delete"],
	["unlink", "delete"],
	["renameSync", "rename"],
	["rename", "rename"],
	["copyFileSync", "copy"],
	["copyFile", "copy"],
	["cpSync", "copy"],
	["cp", "copy"],
];

function resolveArgText(arg: string, vars: ReadonlyMap<string, string>): string | undefined {
	const trimmed = arg.trim();
	const literalPattern = new RegExp("^[\"'" + BACKTICK + "]([^\"'" + BACKTICK + "]*)[\"'" + BACKTICK + "]$");
	const literal = trimmed.match(literalPattern);
	if (literal?.[1]) return literal[1];
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return vars.get(trimmed);
	if (trimmed.startsWith(BACKTICK)) return substituteVars(trimmed.slice(1, -1), vars);
	return undefined;
}

const FILE_READ_PATTERN = /Bun\.file\s*\(\s*([^,)\n]+?)\s*\)\s*\.\s*(?:text|json|arrayBuffer|bytes|stream)\s*\(/g;

function fileCandidates(source: string, vars: ReadonlyMap<string, string>): Candidate[] {
	const candidates: Candidate[] = [];
	for (const match of source.matchAll(FILE_EFFECT_PATTERN)) {
		const call = match[0];
		const verb = FILE_EFFECT_VERBS.find(([name]) => call.includes(name))?.[1];
		if (!verb) continue;
		const path = resolveArgText(match[1] ?? "", vars);
		if (path) candidates.push({ kind: "ts", text: descriptor(verb + " " + path), score: 95 });
	}
	for (const match of source.matchAll(FILE_READ_PATTERN)) {
		const path = resolveArgText(match[1] ?? "", vars);
		if (path) candidates.push({ kind: "ts", text: descriptor("read " + path), score: 70 });
	}
	for (const match of source.matchAll(/\bfetch\s*\(\s*([^,)\n]+)/g)) {
		const url = resolveArgText(match[1] ?? "", vars);
		if (url) candidates.push({ kind: "ts", text: descriptor("fetch " + url), score: 75 });
	}
	return candidates;
}

//--- bridged host tools ---

/** Per-tool: which argument names the target, the verb shown, and the band. */
const BRIDGED_TOOLS: Record<string, { arg: string; verb: string; score: number }> = {
	read: { arg: "path", verb: "read", score: 70 },
	bash: { arg: "command", verb: "", score: 88 },
	edit: { arg: "path", verb: "edit", score: 95 },
	write: { arg: "path", verb: "write", score: 95 },
	grep: { arg: "pattern", verb: "grep", score: 68 },
	find: { arg: "pattern", verb: "find", score: 68 },
	ls: { arg: "path", verb: "ls", score: 68 },
};

function bridgedToolCandidates(source: string, vars: ReadonlyMap<string, string>): Candidate[] {
	const candidates: Candidate[] = [];
	for (const match of source.matchAll(/\btools\.(\w+)\s*\(\s*\{([^}]*)\}/g)) {
		const spec = BRIDGED_TOOLS[match[1] ?? ""];
		if (!spec) continue;
		const props = match[2] ?? "";
		const argMatch = props.match(new RegExp(spec.arg + "\\s*:\\s*([^,}]+)"));
		const target = argMatch ? resolveArgText(argMatch[1] ?? "", vars) : undefined;
		if (!target) continue;
		// --- a bridged bash call is a command like any other ---
		const text = spec.verb ? spec.verb + " " + target : previewShellCommand(target) || target;
		candidates.push({ kind: "ts", text: descriptor(text), score: spec.score });
	}
	return candidates;
}

//--- generic line scoring ---

const SKIP_LINE_PATTERN = /^(?:$|\/\/|\/\*|\*|import\s|export\s+(?:type\s|\{)|[})\];,]+$)/;
const DEFINITION_PATTERN = /^(?:export\s+)?(?:async\s+)?(?:function\s|class\s|interface\s|type\s+\w+\s*=)/;
const ARROW_DEFINITION_PATTERN = /^(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(?[^)=]*\)?\s*=>/;
const CONTROL_PATTERN = /^(?:if|for|while|switch|try|do)\b/;
const CALL_STATEMENT_PATTERN = /^(?:await\s+)?[A-Za-z_$][\w$.]*\s*\(/;
const ASSIGNMENT_CALL_PATTERN = /^(?:const|let|var)\s+[^=]{1,60}=\s*(?:await\s+)?(?:new\s+)?[A-Za-z_$][\w$.]*\s*\(/;
const LOW_SIGNAL_CALL_PATTERN =
	/^(?:await\s+)?(?:console\.\w+|String|Number|Boolean|JSON\.stringify|JSON\.parse|structuredClone)\s*\(/;
const LOW_SIGNAL_ASSIGNMENT_PATTERN =
	/=\s*(?:await\s+)?(?:JSON\.parse|JSON\.stringify|String|Number|Boolean|Object\.keys|Object\.entries)\s*\(/;

function consoleInnerCall(line: string): string | undefined {
	const inner = line.match(/^console\.\w+\(\s*(.+)\)\s*;?\s*$/)?.[1]?.trim();
	return inner && CALL_STATEMENT_PATTERN.test(inner) && !LOW_SIGNAL_CALL_PATTERN.test(inner) ? inner : undefined;
}

function genericLineScore(line: string): number {
	if (SKIP_LINE_PATTERN.test(line)) return -1;
	if (LOW_SIGNAL_ASSIGNMENT_PATTERN.test(line)) return 25;
	if (consoleInnerCall(line)) return 55;
	if (LOW_SIGNAL_CALL_PATTERN.test(line)) return 15;
	if (DEFINITION_PATTERN.test(line) || ARROW_DEFINITION_PATTERN.test(line)) return 50;
	if (CONTROL_PATTERN.test(line)) return 20;
	if (/^(?:return|throw)\b/.test(line)) return 45;
	if (ASSIGNMENT_CALL_PATTERN.test(line)) return 60;
	if (CALL_STATEMENT_PATTERN.test(line)) return 65;
	if (/^(?:const|let|var)\s/.test(line)) return 22;
	return 30;
}

function genericCandidates(masked: string): Candidate[] {
	const candidates: Candidate[] = [];
	for (const [index, rawLine] of masked.split("\n").entries()) {
		const line = rawLine.trim();
		const score = genericLineScore(line);
		if (score < 0) continue;
		const text = consoleInnerCall(line) ?? line;
		// --- later lines win ties: cells read as setup-then-act, and the act is the story ---

		candidates.push({ kind: "ts", text: descriptor(text), score: score + Math.min(index, 90) / 100 });
	}
	return candidates;
}

//--- entry point ---

export function previewCell(code: string): CellPreview {
	const source = code.trimEnd();
	if (!source) return { kind: "ts", text: "" };
	const vars = stringConsts(source);

	// --- scan order matters: agent masks shell-looking syntax before the shell scan ---
	const agent = agentCandidates(source, vars);
	const shell = shellCandidates(agent.masked, vars);
	const candidates: Candidate[] = [
		...agent.candidates,
		...shell.candidates,
		...fileCandidates(shell.masked, vars),
		...bridgedToolCandidates(shell.masked, vars),
		...genericCandidates(shell.masked),
	];

	let best: Candidate | undefined;
	for (const candidate of candidates) {
		if (candidate.text && (!best || candidate.score > best.score)) best = candidate;
	}
	return best ?? { kind: "ts", text: "" };
}
