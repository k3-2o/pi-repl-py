/**
 * config.ts — reads the user's pi-repl config.
 *
 * Where the venv python path, the toolbox directory, and timeouts are
 * configured. First-found-wins, never throws on a missing/malformed file.
 *
 *   $PI_REPL_CONFIG            explicit env override
 *   ~/.pi/agent/pi-repl.json   user-global (same dir as pi's settings.json)
 *
 * The loadable function set is the toolbox directory (see engine/toolbox/);
 * there is no separate helpers list. The extension ships with the four default
 * functions (read/write/edit/bash) and a user points toolboxDir at their own
 * folder to replace them.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ReplConfig {
	/** Python interpreter used to spawn the guest. Defaults to the venv / PATH. */
	pythonPath?: string;
	/** Directory of toolbox function files, exec'd into every kernel. */
	toolboxDir?: string;
	/** Per-cell execution timeout, ms. Default 60_000. */
	timeoutMs: number;
	/** Debounce for the auto-snapshot after an ok cell, ms. Default 1500. */
	snapshotDebounceMs: number;
}

const DEFAULT_CONFIG: ReplConfig = {
	timeoutMs: 60_000,
	snapshotDebounceMs: 1500,
};

function num(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

function configCandidates(): string[] {
	const env = process.env.PI_REPL_CONFIG;
	const user = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".pi", "agent"), "pi-repl.json");
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
				toolboxDir: typeof r.toolboxDir === "string" && r.toolboxDir.length > 0 ? r.toolboxDir : undefined,
				timeoutMs: num(r.timeoutMs, DEFAULT_CONFIG.timeoutMs),
				snapshotDebounceMs: num(r.snapshotDebounceMs, DEFAULT_CONFIG.snapshotDebounceMs),
			};
		} catch {}
	}
	return { ...DEFAULT_CONFIG };
}
