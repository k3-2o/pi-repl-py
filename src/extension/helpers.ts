/** Loads helpers from the ONE fixed dir; `helper_description` surfaces verbatim (no signature parsing). */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

interface HelperEntry {
	name: string;
	description: string; // full helper_description body, "" if absent
}

/** Extract `helper_description = """..."""` (or `'''`) verbatim; no signature parsing. */
function parseDescription(source: string): string {
	const m = source.match(/helper_description\s*=\s*("""|''')([\s\S]*?)\1/);
	return m ? m[2].trim() : "";
}

/** Load {name → entry} for each non-underscore *.py in the helpers dir. */
function loadHelperEntries(dir?: string): HelperEntry[] {
	const d = dir ?? DEFAULT_HELPERS_DIR;
	if (!existsSync(d)) return [];
	const entries: HelperEntry[] = [];
	for (const file of readdirSync(d).sort()) {
		if (!file.endsWith(".py")) continue;
		const name = file.slice(0, -3);
		if (!/^[A-Za-z_]\w*$/.test(name)) continue;
		// --- underscore-prefixed files are neither loaded nor advertised ---
		if (name.startsWith("_")) continue;
		try {
			const source = readFileSync(join(d, file), "utf8");
			entries.push({ name, description: parseDescription(source) });
		} catch {}
	}
	return entries;
}

/** The prompt-facing list, one bullet per loaded file (verbatim description, or an introspection pointer). */
export function buildHelpersMap(dir?: string): string[] {
	return loadHelperEntries(dir).map((t) =>
		t.description
			? `- ${t.description.replace(/\n/g, "\n  ")}`
			: `- ${t.name} (no description — inspect it with print(${t.name}.__doc__))`,
	);
}
