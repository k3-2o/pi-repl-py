// --- candidates: a Python-flavored file detector plus generic line scoring ---

import { descriptor } from "./descriptor.js";
import type { Candidate } from "./types.js";

// --- Python file effects: verb + literal path, in the idioms this evaluator runs ---

const PY_CHAINED_METHOD: ReadonlyArray<[string, string, number]> = [
	["write_text", "write", 95],
	["write_bytes", "write", 95],
	["append_text", "append", 90],
	["read_text", "read", 70],
	["read_bytes", "read", 70],
	["mkdir", "mkdir", 80],
	["rmdir", "delete", 85],
	["unlink", "delete", 85],
	["touch", "touch", 80],
	["write", "write", 95],
	["read", "read", 70],
];

const PY_METHOD_VERB: Record<string, [string, number]> = Object.fromEntries(
	PY_CHAINED_METHOD.map(([method, verb, score]) => [method, [verb, score]]),
);

/** `Path("p").method(...)` / `open("p"[, "mode"]).method(...)` — mode overrides the method verb. */
const PY_CHAINED_PATTERN = new RegExp(
	"(?:Path|open)\\s*\\(\\s*([rf]?[\"'])([^\"']+)\\1\\s*(?:,\\s*[\"']([rawx])[\"'])?\\s*\\)\\s*\\.\\s*(" +
		PY_CHAINED_METHOD.map(([method]) => method).join("|") +
		")\\s*\\(",
	"g",
);

/** A bare `open("p", "mode")`, including `with open(...)` blocks. */
const PY_OPEN_PATTERN = /open\s*\(\s*([rf]?["'])([^"']+)\1\s*,\s*["']([rawx])["']\s*\)/g;

/** Function-form effects from the stdlib modules this repl's cells actually use. */
const PY_FN_PATTERN =
	/((?:shutil|os)\.(?:copy|copytree|move|rmtree|remove|unlink|rmdir|mkdir|makedirs|rename|replace))\s*\(\s*([rf]?["'])([^"']+)\2(?:\s*,\s*([rf]?["'])([^"']+)\4)?/g;

const PY_FN_VERB: Record<string, [string, number]> = {
	"shutil.copy": ["copy", 85],
	"shutil.copytree": ["copy", 85],
	"shutil.move": ["move", 85],
	"shutil.rmtree": ["delete", 90],
	"os.remove": ["delete", 85],
	"os.unlink": ["delete", 85],
	"os.rmdir": ["delete", 85],
	"os.mkdir": ["mkdir", 80],
	"os.makedirs": ["mkdir", 80],
	"os.rename": ["rename", 85],
	"os.replace": ["rename", 85],
};

export function pythonFileCandidates(source: string): Candidate[] {
	const candidates: Candidate[] = [];
	for (const match of source.matchAll(PY_CHAINED_PATTERN)) {
		const spec = PY_METHOD_VERB[match[4] ?? ""];
		if (!spec) continue;
		const mode = match[3];
		const verb = mode === "a" ? "append" : mode === "w" || mode === "x" ? "write" : mode === "r" ? "read" : spec[0];
		candidates.push({ text: descriptor(`${verb} ${match[2]}`), score: mode === undefined ? spec[1] : 95 });
	}
	for (const match of source.matchAll(PY_OPEN_PATTERN)) {
		const verb = match[3] === "a" ? "append" : match[3] === "r" ? "read" : "write";
		candidates.push({ text: descriptor(`${verb} ${match[2]}`), score: 95 });
	}
	for (const match of source.matchAll(PY_FN_PATTERN)) {
		const spec = PY_FN_VERB[match[1] ?? ""];
		if (!spec) continue;
		const target = match[5];
		const text = target ? `${spec[0]} ${match[3]} → ${target}` : `${spec[0]} ${match[3]}`;
		candidates.push({ text: descriptor(text), score: spec[1] });
	}
	return candidates;
}

const SKIP_LINE_PATTERN = /^(?:$|#|\/\/|\/\*|\*|import\s|from\s+\S+\s+import|export\s+(?:type\s|\{)|[})\];,]+$)/;
const DEFINITION_PATTERN = /^(?:export\s+)?(?:async\s+)?(?:function\s|def\s|class\s|interface\s|type\s+\w+\s*=)/;
const ARROW_DEFINITION_PATTERN = /^(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(?[^)=]*\)?\s*=>/;
const CONTROL_PATTERN = /^(?:if|for|while|switch|try|do)\b/;
const CALL_STATEMENT_PATTERN = /^(?:await\s+)?[A-Za-z_$][\w$.]*\s*\(/;
const ASSIGNMENT_CALL_PATTERN = /^(?:const|let|var|def)\s+[^=]{1,60}=\s*(?:await\s+)?(?:new\s+)?[A-Za-z_$][\w$.]*\s*\(/;
const PY_ASSIGNMENT_CALL_PATTERN = /^[A-Za-z_][\w]*\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*\(/;
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
	if (ASSIGNMENT_CALL_PATTERN.test(line) || PY_ASSIGNMENT_CALL_PATTERN.test(line)) return 60;
	if (CALL_STATEMENT_PATTERN.test(line)) return 65;
	if (/^(?:const|let|var)\s/.test(line)) return 22;
	return 30;
}

export function genericCandidates(source: string): Candidate[] {
	const candidates: Candidate[] = [];
	for (const [index, rawLine] of source.split("\n").entries()) {
		const line = rawLine.trim();
		const score = genericLineScore(line);
		if (score < 0) continue;
		const text = consoleInnerCall(line) ?? line;
		// --- later lines win ties: cells read as setup-then-act, and the act is the story ---
		candidates.push({ text: descriptor(text), score: score + Math.min(index, 90) / 100 });
	}
	return candidates;
}
