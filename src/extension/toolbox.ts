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
import { homedir } from "node:os";
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

/** Expand a leading `~` to the user's home, matching the guest's expanduser. */
function expandTilde(p: string): string {
	const home = homedir();
	if (p === "~" || p === "~/") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
	return p;
}

/** Resolve a toolbox dir the way the config intends (expand ~, missing → shipped default). */
function toolboxDir(dir: string | undefined): string {
	return dir && dir.trim().length > 0 ? expandTilde(dir.trim()) : defaultToolboxDir();
}

/** Load {function_name → entry} for each non-underscore *.py in `dir`. */
function loadToolboxEntries(dir: string | undefined): ToolEntry[] {
	const d = toolboxDir(dir);
	if (!existsSync(d)) return [];
	const entries: ToolEntry[] = [];
	for (const file of readdirSync(d).sort()) {
		if (!file.endsWith(".py")) continue;
		const name = file.slice(0, -3);
		if (!/^[A-Za-z_]\w*$/.test(name)) continue;
		// --- underscore-prefixed files are neither loaded nor advertised ---
		if (name.startsWith("_")) continue;
		try {
			const source = readFileSync(join(d, file), "utf8");
			const call = parseDefCall(source);
			if (!call) continue;
			entries.push({ name, call, description: parseDescription(source) });
		} catch {}
	}
	return entries;
}

/**
 * The shipped built-in function set, always present (the canonical toolbox).
 */
function builtInEntries(): ToolEntry[] {
	return loadToolboxEntries(undefined);
}

/**
 * The effective function map: the shipped built-ins are supreme (always
 * present); the config `toolboxDir`, if set, adds any extra function and, when
 * a name collides, overrides the built-in one. `~` is resolved like the guest.
 */
export function buildToolboxMap(dir: string | undefined): string[] {
	const byName = new Map<string, ToolEntry>();
	for (const e of builtInEntries()) byName.set(e.name, e);
	if (dir && dir.trim().length > 0 && toolboxDir(dir) !== defaultToolboxDir()) {
		for (const e of loadToolboxEntries(dir)) byName.set(e.name, e);
	}
	return [...byName.values()].map((t) => (t.description ? `- ${t.call}: ${t.description}` : `- ${t.call}`));
}
