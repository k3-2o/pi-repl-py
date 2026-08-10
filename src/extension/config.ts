/**
 * config.ts — reads the user's pi-repl config.
 *
 * Where the venv python path, the helpers directory, and timeouts are
 * configured. First-found-wins, never throws on a missing/malformed file.
 *
 *   $PI_REPL_CONFIG                 explicit env override
 *   ~/.pi/agent/pi-repl/config.json   user-global
 *
 * The loadable set lives in ONE location: the helpers dir (default
 * ~/.pi/agent/pi-repl/helpers). The default shell.py + edit.py blocks are
 * auto-seeded there on install (changing no user edits); the user edits the
 * dir freely. There is no shipped helper folder or toolbox in the package.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ReplConfig {
	/** Python interpreter used to spawn the guest. Defaults to the venv / PATH. */
	pythonPath?: string;
	/** Directory of helper files, exec'd into every kernel. Default: ~/.pi/agent/pi-repl/helpers. */
	helpersDir?: string;
	/** Stall watchdog, ms: 0 = no cap, nonzero = no-output-for-N-ms trips it. */
	timeoutMs: number;
	/** Debounce for the auto-snapshot after an ok cell, ms. Default 1500. */
	snapshotDebounceMs: number;
}

const DEFAULT_CONFIG: ReplConfig = {
	// --- timeoutMs: 0 = no cap; nonzero = silence watchdog (no output for N ms) ---
	timeoutMs: 0,
	snapshotDebounceMs: 1500,
};

function num(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

function configCandidates(): string[] {
	const env = process.env.PI_REPL_CONFIG;
	const user = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".pi", "agent", "pi-repl"), "config.json");
	return [env, user].filter((p): p is string => !!p && p.length > 0);
}

/** Load + validate; return defaults on any failure. */
export function loadConfig(): ReplConfig {
	for (const file of configCandidates()) {
		try {
			if (!existsSync(file)) continue;
			const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
			const r = raw as Record<string, unknown>;
			return {
				pythonPath: typeof r.pythonPath === "string" && r.pythonPath.length > 0 ? r.pythonPath : undefined,
				helpersDir: typeof r.helpersDir === "string" && r.helpersDir.length > 0 ? r.helpersDir : undefined,
				timeoutMs: num(r.timeoutMs, DEFAULT_CONFIG.timeoutMs),
				snapshotDebounceMs: num(r.snapshotDebounceMs, DEFAULT_CONFIG.snapshotDebounceMs),
			};
		} catch {}
	}
	return { ...DEFAULT_CONFIG };
}
