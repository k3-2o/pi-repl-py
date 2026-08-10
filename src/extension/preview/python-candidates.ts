// --- python-candidates: rank Python cell intent for the one-line header ---

import { descriptor } from "./descriptor.js";
import {
	extractPythonString,
	findPythonCallEnd,
	pythonStringConsts,
	readPythonStringOrIdentifier,
	resolvePythonExpr,
} from "./python-scan.js";
import { previewShellCommandScored, SHELL_SETUP_WORDS, shellWords } from "./shell.js";
import type { Candidate } from "./types.js";

const PYTHONISH_RE =
	/(?:^|\n)\s*(?:!\w|%%\w|%\w+\b)|(?<![A-Za-z0-9_.])\b(?:bash\s*\(|read\s*\(|write\s*\(|edit\s*\(|web_search\s*\(|open\s*\(|Path\s*\(|import\s+[A-Za-z_]\w+|from\s+\S+\s+import\b|def\s+\w+\s*\(|class\s+\w+\s*[:(]|if\s+__name__|print\s*\()|(?:^|\n|\b)[fF][rR]?['"]|(?:^|\n|\b)[rR][fF]?['"]|\b(?:subprocess|os|shutil)\.[A-Za-z_]\w+\s*\(/m;

export function isPythonish(source: string): boolean {
	return PYTHONISH_RE.test(source);
}

function extractPythonKeywordArg(
	source: string,
	callStart: number,
	argName: string,
	vars: ReadonlyMap<string, string>,
): string | undefined {
	const open = source.indexOf("(", callStart);
	if (open < 0) return undefined;
	const close = findPythonCallEnd(source, open);
	if (!close) return undefined;
	const args = source.slice(open + 1, close);
	const re = new RegExp(`\\b${argName}\\s*=\\s*`);
	const match = args.match(re);
	if (!match || match.index === undefined) return undefined;
	const pos = match.index + match[0].length;
	const value = readPythonStringOrIdentifier(args, pos, vars);
	return value?.value;
}

function extractPythonFirstArg(
	source: string,
	callStart: number,
	vars: ReadonlyMap<string, string>,
): string | undefined {
	const open = source.indexOf("(", callStart);
	if (open < 0) return undefined;
	const close = findPythonCallEnd(source, open);
	if (!close) return undefined;
	const args = source.slice(open + 1, close);
	const value = readPythonStringOrIdentifier(args, 0, vars);
	return value?.value;
}

function extractPythonToolArg(
	source: string,
	callStart: number,
	keyword: string,
	vars: ReadonlyMap<string, string>,
): string | undefined {
	return extractPythonKeywordArg(source, callStart, keyword, vars) ?? extractPythonFirstArg(source, callStart, vars);
}

function expandPythonString(text: string, vars: ReadonlyMap<string, string>): string {
	return text.replace(/\{([A-Za-z_]\w*)\}/g, (whole, name: string) => vars.get(name) ?? whole);
}

function maskSpan(source: string, start: number, end: number): string {
	return source.slice(0, start) + " ".repeat(Math.max(0, end - start)) + source.slice(end);
}

function maskPythonStrings(source: string): string {
	const chars = [...source];
	let i = 0;
	while (i < source.length) {
		if (source[i] === "#") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (source[i] === '"' || source[i] === "'") {
			const extracted = extractPythonString(source, i);
			if (extracted) {
				for (let j = i; j < extracted.end; j++) chars[j] = " ";
				i = extracted.end;
				continue;
			}
		}
		i++;
	}
	return chars.join("");
}

const PYTHON_SKIP_LINE = /^\s*(?:#|import\s|from\s+\S+\s+import\b|pass|"""|''')/;
const PYTHON_DEF_PATTERN = /^\s*(?:def|class)\s+\w/;
const PYTHON_CONTROL_PATTERN = /^\s*(?:if|for|while|try|except|with|else|elif|finally|match|case)\b/;
const PYTHON_ASSIGNMENT_CALL = /^\s*[A-Za-z_]\w*\s*=\s*(?:await\s+)?[A-Za-z_][\w.]*\s*\(/;
const PYTHON_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_][\w.]*\s*\(/;

function printInnerCall(line: string): string | undefined {
	const inner = line.match(/^\s*print\s*\(\s*(.+?)\s*\)\s*:?$/)?.[1]?.trim();
	if (!inner) return undefined;
	return /[A-Za-z_]\w*\s*\(/.test(inner) ? inner : undefined;
}

function pythonGenericLineScore(line: string): number {
	if (PYTHON_SKIP_LINE.test(line)) return -1;
	if (PYTHON_DEF_PATTERN.test(line)) return 50;
	if (PYTHON_CONTROL_PATTERN.test(line)) return 20;
	if (PYTHON_ASSIGNMENT_CALL.test(line)) return 60;
	if (PYTHON_CALL_PATTERN.test(line)) return 65;
	if (/^\s*[A-Za-z_]\w*\s*=/.test(line)) return 30;
	if (/^\s*return\b/.test(line)) return 45;
	if (/^\s*print\s*\(/.test(line)) return printInnerCall(line) ? 65 : 45;
	return 25;
}

export function pythonGenericCandidates(source: string): Candidate[] {
	const candidates: Candidate[] = [];
	for (const [index, rawLine] of source.split("\n").entries()) {
		const line = rawLine.trim();
		const score = pythonGenericLineScore(rawLine);
		if (score < 0) continue;
		const text = printInnerCall(line) ?? line;
		candidates.push({ kind: "ts", text: descriptor(text), score: score + Math.min(index, 90) / 100 });
	}
	return candidates;
}

export function pythonCandidates(source: string, vars: ReadonlyMap<string, string>): Candidate[] {
	const candidates: Candidate[] = [];
	let masked = maskPythonStrings(source);

	// bash(...) / read(...) / write(...) / edit(...) / web_search(...)
	for (const { name, keyword, score } of [
		{ name: "bash", keyword: "command", score: 90 },
		{ name: "read", keyword: "path", score: 70 },
		{ name: "write", keyword: "path", score: 95 },
		{ name: "edit", keyword: "path", score: 95 },
		{ name: "web_search", keyword: "query", score: 85 },
	]) {
		const re = new RegExp(`(?<![A-Za-z0-9_.])\\b${name}\\s*\\(`, "g");
		for (const match of masked.matchAll(re)) {
			const start = match.index;
			let arg: string | undefined;
			if (name === "bash") {
				arg = extractPythonKeywordArg(source, start, "command", vars) ?? extractPythonFirstArg(source, start, vars);
			} else {
				arg = extractPythonToolArg(source, start, keyword, vars);
			}
			if (arg) arg = expandPythonString(arg, vars);
			if (arg) {
				if (name === "bash") {
					const { text, strength } = previewShellCommandScored(arg);
					if (text) {
						const setupOnly = SHELL_SETUP_WORDS.has(shellWords(text)[0] ?? "");
						const s = setupOnly ? 72 : score + Math.min(strength, 200) / 25;
						candidates.push({ kind: "shell", text: descriptor(text), score: s });
					}
				} else {
					candidates.push({ kind: "ts", text: descriptor(`${name} ${arg}`), score });
				}
			}
			const open = source.indexOf("(", start);
			const close = open >= 0 ? findPythonCallEnd(source, open) : undefined;
			if (close) masked = maskSpan(masked, start, close);
		}
	}

	// IPython !cmd
	for (const match of source.matchAll(/(?:^|\n)\s*!\s*([^\n#]+)/g)) {
		let cmd = match[1]?.trim() ?? "";
		if (cmd) cmd = expandPythonString(cmd, vars);
		if (cmd) {
			const { text, strength } = previewShellCommandScored(cmd);
			if (text) {
				const setupOnly = SHELL_SETUP_WORDS.has(shellWords(text)[0] ?? "");
				const score = setupOnly ? 72 : 90 + Math.min(strength, 200) / 25;
				candidates.push({ kind: "shell", text: descriptor(text), score });
			}
		}
	}

	// %%bash cell magic
	const cellMagic = source.match(/(?:^|\n)\s*%%bash\s*\n([\s\S]*)/);
	if (cellMagic) {
		let cmd = cellMagic[1]?.trim() ?? "";
		if (cmd) cmd = expandPythonString(cmd, vars);
		if (cmd) {
			const { text, strength } = previewShellCommandScored(cmd);
			if (text) {
				const setupOnly = SHELL_SETUP_WORDS.has(shellWords(text)[0] ?? "");
				const score = setupOnly ? 72 : 90 + Math.min(strength, 200) / 25;
				candidates.push({ kind: "shell", text: descriptor(text), score });
			}
		}
	}

	// Python file mutations via open(..., 'w') / Path(...).write_text(...) / os.makedirs / etc.
	for (const match of source.matchAll(/\bopen\s*\(\s*([^,)\n]+)\s*,\s*["'](?:w|a|x|wb|ab|xb)/g)) {
		let path = resolvePythonExpr(match[1] ?? "", vars);
		if (path) path = expandPythonString(path, vars);
		if (path) candidates.push({ kind: "ts", text: descriptor(`write ${path}`), score: 95 });
	}
	for (const match of source.matchAll(/\bPath\s*\(\s*([^,)\n]+)\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/g)) {
		let path = resolvePythonExpr(match[1] ?? "", vars);
		if (path) path = expandPythonString(path, vars);
		if (path) candidates.push({ kind: "ts", text: descriptor(`write ${path}`), score: 95 });
	}
	for (const match of source.matchAll(/\bos\.makedirs\s*\(\s*([^,)\n]+)/g)) {
		let path = resolvePythonExpr(match[1] ?? "", vars);
		if (path) path = expandPythonString(path, vars);
		if (path) candidates.push({ kind: "ts", text: descriptor(`mkdir ${path}`), score: 70 });
	}
	for (const match of source.matchAll(/\b(?:os\.remove|os\.unlink|shutil\.rmtree)\s*\(\s*([^,)\n]+)/g)) {
		let path = resolvePythonExpr(match[1] ?? "", vars);
		if (path) path = expandPythonString(path, vars);
		if (path) candidates.push({ kind: "ts", text: descriptor(`delete ${path}`), score: 95 });
	}
	for (const match of source.matchAll(/\bos\.rename\s*\(\s*([^,)\n]+)\s*,\s*([^,)\n]+)/g)) {
		let fromPath = resolvePythonExpr(match[1] ?? "", vars);
		let toPath = resolvePythonExpr(match[2] ?? "", vars);
		if (fromPath) fromPath = expandPythonString(fromPath, vars);
		if (toPath) toPath = expandPythonString(toPath, vars);
		if (fromPath && toPath)
			candidates.push({ kind: "ts", text: descriptor(`rename ${fromPath} → ${toPath}`), score: 95 });
	}

	// subprocess / os.system as shell previews
	for (const match of source.matchAll(
		/\b(?:subprocess\.run|subprocess\.call|subprocess\.check_output|os\.system)\s*\(/g,
	)) {
		let arg = extractPythonFirstArg(source, match.index, vars);
		if (arg) arg = expandPythonString(arg, vars);
		if (arg) {
			const { text, strength } = previewShellCommandScored(arg);
			if (text) {
				const score = 90 + Math.min(strength, 200) / 25;
				candidates.push({ kind: "shell", text: descriptor(text), score });
			}
		}
	}

	candidates.push(...pythonGenericCandidates(source));
	return candidates;
}

export { pythonStringConsts };
