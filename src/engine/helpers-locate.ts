// --- helpers-locate: pure dir resolution shared by the prompt loader and the kernel preload. ---
// Both sides must agree on the SAME file list or the prompt advertises helpers the kernel never
// defined. Project dirs are looked up from cwd walking up to the git root (pi's skills convention);
// first-seen wins, so a project helper shadows the same-named global one. ---

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GLOBAL_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

/** Ordered candidate dirs: nearest .pi/helpers up to the git root, then the global dir last. */
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
