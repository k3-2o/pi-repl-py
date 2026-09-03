// --- shared helper-dir resolution: prompt and kernel must read the same ordered list ---
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GLOBAL_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

export function resolveHelperDirs(cwd?: string, globalDir?: string): string[] {
	const dirs: string[] = [];
	if (cwd) {
		let cur = resolve(cwd);
		for (;;) {
			const d = join(cur, ".pi", "helpers");
			if (existsSync(d)) dirs.push(d);
			if (existsSync(join(cur, ".git"))) break;
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	dirs.push(globalDir ?? GLOBAL_HELPERS_DIR);
	return dirs;
}
