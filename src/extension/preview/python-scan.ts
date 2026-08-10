// --- python-scan: string/call scanners for Python preview ---

export function extractPythonString(source: string, start: number): { value: string; end: number } | undefined {
	let i = start;
	while (i < source.length && /[a-zA-Z]/.test(source[i]) && i - start < 2) i++;
	if (i >= source.length || (source[i] !== "'" && source[i] !== '"')) return undefined;

	const quoteStart = i;
	const rest = source.slice(quoteStart);
	let quote: string;
	let quoteLen: number;
	if (rest.startsWith("'''")) {
		quote = "'''";
		quoteLen = 3;
	} else if (rest.startsWith('"""')) {
		quote = '"""';
		quoteLen = 3;
	} else if (rest.startsWith("'") || rest.startsWith('"')) {
		quote = rest[0];
		quoteLen = 1;
	} else {
		return undefined;
	}

	const contentStart = quoteStart + quoteLen;
	let pos = contentStart;
	while (pos < source.length) {
		if (source.slice(pos, pos + quoteLen) === quote) {
			let backslashes = 0;
			let b = pos - 1;
			while (b >= contentStart && source[b] === "\\") {
				backslashes++;
				b--;
			}
			if (backslashes % 2 === 0) {
				return { value: source.slice(contentStart, pos), end: pos + quoteLen };
			}
		}
		pos++;
	}
	return undefined;
}

export function findPythonCallEnd(source: string, openPos: number): number | undefined {
	if (source[openPos] !== "(") return undefined;
	let depth = 1;
	let i = openPos + 1;
	let inString: { quote: string; len: number } | undefined;
	while (i < source.length && depth > 0) {
		const ch = source[i];
		if (inString) {
			if (source.slice(i, i + inString.len) === inString.quote) {
				let backslashes = 0;
				let b = i - 1;
				while (b >= 0 && source[b] === "\\") {
					backslashes++;
					b--;
				}
				if (backslashes % 2 === 0) {
					i += inString.len;
					inString = undefined;
					continue;
				}
			}
			i++;
			continue;
		}
		if (ch === "#") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
		} else if (ch === '"' || ch === "'") {
			const triple = source.slice(i, i + 3);
			if (triple === '"""' || triple === "'''") {
				inString = { quote: triple, len: 3 };
				i += 3;
				continue;
			}
			inString = { quote: ch, len: 1 };
		}
		i++;
	}
	return depth === 0 ? i : undefined;
}

export function pythonStringConsts(source: string): Map<string, string> {
	const vars = new Map<string, string>();
	const re = /([A-Za-z_]\w*)\s*=\s*(?=['"])/g;
	for (const match of source.matchAll(re)) {
		const name = match[1];
		if (!name) continue;
		const strStart = match.index + match[0].length;
		const extracted = extractPythonString(source, strStart);
		if (extracted) vars.set(name, extracted.value);
	}
	return vars;
}

function isQuoteStart(source: string, i: number): boolean {
	let j = i;
	while (j < source.length && /[a-zA-Z]/.test(source[j]) && j - i < 2) j++;
	const rest = source.slice(j);
	return rest.startsWith("'") || rest.startsWith('"');
}

export function readPythonStringOrIdentifier(
	source: string,
	start: number,
	vars: ReadonlyMap<string, string>,
): { value: string; end: number } | undefined {
	let i = start;
	while (i < source.length && /\s/.test(source[i])) i++;
	if (isQuoteStart(source, i)) {
		const extracted = extractPythonString(source, i);
		if (extracted) return extracted;
	}
	const idMatch = source.slice(i).match(/^[A-Za-z_]\w*/);
	if (idMatch) {
		const value = vars.get(idMatch[0]);
		if (value) return { value, end: i + idMatch[0].length };
	}
	return undefined;
}

export function resolvePythonExpr(expr: string, vars: ReadonlyMap<string, string>): string | undefined {
	const trimmed = expr.trim();
	const str = extractPythonString(trimmed, 0);
	if (str) return str.value;
	const id = trimmed.match(/^[A-Za-z_]\w*/)?.[0];
	if (id) return vars.get(id);
	return undefined;
}
