// --- shell: resolve the strongest single line of a (possibly chained) shell command ---
import { descriptor } from "./descriptor.js";

const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+?)\s*(?:&&|;)\s*/;
const SHELL_SETUP_PATTERN = /^(?:export\s+\w+=|set\s+[-+]|source\s+\S+|\.\s+\S+)/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

export function shellWords(line: string): string[] {
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

// --- collapse noisier command forms (runners, writes) down to the intent ---
function simplifyShellLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

// --- commands that prepare the ground; the shell only wins when it is the story ---
export const SHELL_SETUP_WORDS = new Set([
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

export const SHELL_ACTION_WORDS = new Set([
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
		// --- the write target is the story; the body is detail for the expanded view ---
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) return (line.includes("tee -a") ? "append " : "write ") + pathTail(catWrite[1]);
		return descriptor(body);
	}
	return undefined;
}

export function previewShellCommand(command: string): string {
	return previewShellCommandScored(command).text;
}

// --- like previewShellCommand but keeps the winning line's strength so several shell calls can rank ---
export function previewShellCommandScored(command: string): { text: string; strength: number } {
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
	// --- a stripped cd prefix still matters when it names a non-default dir ---
	const text = cwdSuffix && !cleaned.includes(cwdSuffix) ? cleaned + " (" + cwdSuffix + ")" : cleaned;
	return { text: descriptor(text), strength: best.score };
}
