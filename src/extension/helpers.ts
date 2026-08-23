/** Loads helpers from project then global dirs; `helper_description` surfaces verbatim (no signature parsing). */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "../engine/helpers-locate.js";

const DEFAULT_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

interface HelperEntry {
	name: string;
	description: string; // full helper_description body, "" if absent
}

/** Extract `helper_description` verbatim; no signature parsing. */
function parseDescription(source: string): string {
	const m = source.match(/helper_description\s*=\s*("""|''')([\s\S]*?)\1/);
	return m ? m[2].trim() : "";
}

/** Merge entries from ordered dirs; first-seen name wins, so a project helper shadows the global one. */
function loadHelperEntries(dirs: string[]): HelperEntry[] {
	const seen = new Set<string>();
	const entries: HelperEntry[] = [];
	for (const d of dirs) {
		if (!existsSync(d)) continue;
		for (const file of readdirSync(d).sort()) {
			if (!file.endsWith(".py")) continue;
			const name = file.slice(0, -3);
			if (!/^[A-Za-z_]\w*$/.test(name)) continue;
			// --- underscore-prefixed files are neither loaded nor advertised ---
			if (name.startsWith("_")) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			try {
				const source = readFileSync(join(d, file), "utf8");
				entries.push({ name, description: parseDescription(source) });
			} catch {}
		}
	}
	return entries;
}

/** The prompt-facing list for ONE dir: verbatim description, or an introspection pointer. */
export function buildHelpersMap(dir?: string): string[] {
	return loadHelperEntries([dir ?? DEFAULT_HELPERS_DIR]).map((t) =>
		t.description
			? t.description.replace(/\n/g, "\n  ")
			: `${t.name} (no description, inspect it with print(${t.name}.__doc__))`,
	);
}

/** The prompt-facing list at a cwd: project .pi/helpers first (up to the git root), global fallback, project shadows. */
export function buildHelpersMapForCwd(cwd: string, globalDir?: string): string[] {
	return loadHelperEntries(resolveHelperDirs(cwd, globalDir)).map((t) =>
		t.description
			? t.description.replace(/\n/g, "\n  ")
			: `${t.name} (no description, inspect it with print(${t.name}.__doc__))`,
	);
}
