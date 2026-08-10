// --- candidates: the five detectors that name a cell's intent, plus generic scoring ---

import { descriptor } from "./descriptor.js";
import { maskSpan, scanTemplate, substituteVars } from "./scan.js";
import { previewShellCommand, previewShellCommandScored, SHELL_SETUP_WORDS, shellWords } from "./shell.js";
import { BACKTICK, type Candidate } from "./types.js";

const SHELL_OPEN_PATTERN = new RegExp("Bun\\s*\\.\\s*\\$\\s*(?:\\([^)]*\\)\\s*)?" + BACKTICK, "g");

export function shellCandidates(
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

// --- resolve a quoted literal, a known const, or an interpolated template into a plain string ---
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

export function fileCandidates(source: string, vars: ReadonlyMap<string, string>): Candidate[] {
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

// --- per-tool: which arg names the target, the verb shown, and its scoring band ---
const BRIDGED_TOOLS: Record<string, { arg: string; verb: string; score: number }> = {
	read: { arg: "path", verb: "read", score: 70 },
	bash: { arg: "command", verb: "", score: 88 },
	edit: { arg: "path", verb: "edit", score: 95 },
	write: { arg: "path", verb: "write", score: 95 },
	grep: { arg: "pattern", verb: "grep", score: 68 },
	find: { arg: "pattern", verb: "find", score: 68 },
	ls: { arg: "path", verb: "ls", score: 68 },
};

export function bridgedToolCandidates(source: string, vars: ReadonlyMap<string, string>): Candidate[] {
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

export function genericCandidates(masked: string): Candidate[] {
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
