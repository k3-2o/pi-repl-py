// --- scan: tokenizer source → template spans, string constants, and masks ---
import { BACKTICK, type Span } from "./types.js";

// --- capture the template opened at start; tracks escapes + interpolation nesting so a shell command reads whole, and an unclosed template returns the rest (partial is better than none) ---
export function scanTemplate(source: string, start: number): Span {
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

// --- collected simple string constants, for resolving interpolations and path args ---
export function stringConsts(source: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const match of source.matchAll(CONST_STRING_PATTERN)) {
		const name = match[1];
		const value = match[2] ?? match[3] ?? match[4];
		if (name && value !== undefined) vars.set(name, value);
	}
	return vars;
}

export function substituteVars(text: string, vars: ReadonlyMap<string, string>): string {
	return text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) => vars.get(name) ?? whole);
}

// --- blank a claimed span so later detectors don't re-read what an earlier one took ---
export function maskSpan(source: string, span: Span): string {
	return source.slice(0, span.start) + " ".repeat(span.end - span.start) + source.slice(span.end);
}
