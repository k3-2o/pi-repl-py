/**
 * Loads the toolbox functions from the toolbox directory.
 *
 * The prompt-facing function map is derived from the real source, never
 * hard-coded: each function's `def <name>(<args>)` line supplies the signature
 * (authoritative) and the `function_description = """..."""` docstring supplies
 * the one-line "what it does". Same contract the guest's `ls()`/`help()` uses,
 * so what the prompt advertises always matches what the kernel loaded.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ToolEntry {
	name: string;
	call: string; // e.g. "read(path, offset=1, limit=None)"
	description: string; // first line of function_description, "" if absent
}

/** Read a `function_description = """..."""` value; keep its first line. */
function parseDescription(source: string): string {
	const m = source.match(/function_description\s*=\s*"""\s*([^\n]*)/);
	if (!m) return "";
	return m[1].replace(/"""\s*$/, "").trim();
}

/** Regex the call signature from `def name(args):`. */
function parseDefCall(source: string): string | null {
	const m = source.match(/def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
	if (!m) return null;
	const name = m[1];
	const args = m[2].trim();
	return args ? `${name}(${args})` : `${name}()`;
}

/**
 * Default toolbox directory: the shipped src/engine/toolbox. Resolved at
 * runtime via the module path so it stays correct after packaging.
 */
function defaultToolboxDir(): string {
	return join(import.meta.dirname, "..", "..", "src", "engine", "toolbox");
}

/** Load {function_name → source} for each non-underscore *.py in `dir`. */
function loadToolboxEntries(dir: string | undefined): ToolEntry[] {
	const d = dir && dir.length > 0 ? dir : defaultToolboxDir();
	if (!existsSync(d)) return [];
	const entries: ToolEntry[] = [];
	for (const file of readdirSync(d).sort()) {
		if (!file.endsWith(".py")) continue;
		const name = file.slice(0, -3);
		if (!/^[A-Za-z_]\w*$/.test(name)) continue;
		// An underscore-prefixed file is not loaded into the kernel (see guest.py),
		// so it must never be advertised either.
		if (name.startsWith("_")) continue;
		try {
			const source = readFileSync(join(d, file), "utf8");
			const call = parseDefCall(source);
			if (!call) continue;
			entries.push({ name, call, description: parseDescription(source) });
		} catch {
			continue;
		}
	}
	return entries;
}

/**
 * The markdown-style function map: one `- call: description` line per function,
 * ready to drop into the prompt guidelines.
 */
export function buildToolboxMap(dir: string | undefined): string[] {
	return loadToolboxEntries(dir).map((t) => (t.description ? `- ${t.call}: ${t.description}` : `- ${t.call}`));
}
