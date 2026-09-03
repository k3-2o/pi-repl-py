/** helper_description surfaces verbatim — there is no signature parsing. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "../engine/helpers-locate.js";

const DEFAULT_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

interface HelperEntry {
	name: string;
	description: string; // full helper_description body, "" if absent
}

function parseDescription(source: string): string {
	const m = source.match(/helper_description\s*=\s*("""|''')([\s\S]*?)\1/);
	return m ? m[2].trim() : "";
}

/** First-seen name wins, so a project helper shadows a global one. */
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

/** One helper as the model sees it: verbatim description, or a pointer when the file lacks a triple-quoted helper_description. */
function formatHelperLine(entry: HelperEntry): string {
	return entry.description
		? entry.description.replace(/\n/g, "\n  ")
		: `${entry.name} (no helper_description — define one as a triple-quoted string in the file; inspect with print(${entry.name}.__doc__))`;
}

export function buildHelpersMap(dir?: string): string[] {
	return loadHelperEntries([dir ?? DEFAULT_HELPERS_DIR]).map(formatHelperLine);
}

/** Project .pi/helpers first, global fallback, project shadows; honors the kernel's env overrides so the two sides can't diverge. */
export function buildHelpersMapForCwd(cwd: string, globalDir?: string, helpersDir?: string): string[] {
	const dirs = helpersDir ? [helpersDir] : resolveHelperDirs(cwd, globalDir);
	return loadHelperEntries(dirs).map(formatHelperLine);
}

/** System-prompt block for this session's helpers; undefined when there are none. */
export function buildHelpersPromptSection(cwd: string): string | undefined {
	const map = buildHelpersMapForCwd(cwd, process.env.PI_HELPERS_GLOBAL_DIR, process.env.PI_HELPERS_DIR);
	if (map.length === 0) return undefined;
	const lines = [
		"Preloaded helpers, use them as any loaded function or variable:",
		...map.map((line) => `  - ${line.replace(/\n/g, "\n    ")}`),
	];
	return lines.join("\n");
}
