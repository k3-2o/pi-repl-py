/**
 * Loads the helpers from the SINGLE user-owned helpers directory.
 *
 * The prompt-facing list comes straight from each file's
 * `helper_description = """..."""` value, rendered verbatim — no signature
 * parsing, so nothing machine-derived can ever lie about a helper. The
 * convention: the description's first line starts with the call shape
 * (`name(args)`, or `with shell() as run: ...` for a block helper), the rest is
 * what it owns and the "Instead of" equivalence. The kernel's help/ls shows the
 * real object via `inspect`-free listing, so drift in the description is
 * recoverable.
 *
 * There is exactly ONE location (the helpers dir, default
 * `~/.pi/agent/pi-repl/helpers`); there is no shipped toolbox that merges in.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface HelperEntry {
	name: string;
	description: string; // full helper_description body, "" if absent
}

/**
 * Read the whole `helper_description = """..."""` value (or the `'''` form).
 * Content extraction, not signature parsing: the user's prose is the truth.
 */
function parseDescription(source: string): string {
	const m = source.match(/helper_description\s*=\s*("""|''')([\s\S]*?)\1/);
	return m ? m[2].trim() : "";
}

/** Expand a leading `~` to the user's home (matches the guest's expanduser). */
function expandTilde(p: string): string {
	const home = homedir();
	if (p === "~" || p === "~/") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
	return p;
}

/** Resolve a helpers dir: config value else the default install dir. */
function helpersDir(dir: string | undefined): string {
	const d = dir && dir.trim().length > 0 ? dir.trim() : "~/.pi/agent/pi-repl/helpers";
	return expandTilde(d);
}

/** Load {name → entry} for each non-underscore *.py in `dir`. */
export function loadHelperEntries(dir: string | undefined): HelperEntry[] {
	const d = helpersDir(dir);
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

/**
 * The prompt-facing helper list for the single helpers dir. One entry per
 * loaded file, from its `helper_description` verbatim (or a help() pointer).
 */
export function buildHelpersMap(dir: string | undefined): string[] {
	return loadHelperEntries(dir).map((t) =>
		t.description
			? `- ${t.description.replace(/\n/g, "\n  ")}`
			: `- ${t.name} (no description — call help('${t.name}') for a look)`,
	);
}
