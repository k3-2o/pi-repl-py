/**
 * config.ts — reads the user's pi-repl config.
 *
 * Where helpers, the venv python path, timeouts, and subagent defaults are
 * configured. First-found-wins, never throws on a missing/malformed file.
 *
 *   $PI_REPL_CONFIG            explicit env override
 *   ~/.pi/agent/pi-repl.json   user-global (same dir as pi's settings.json)
 *
 * The extension ships with no baked-in tool set — the user opts in via this
 * config. An empty helpers list means a bare kernel.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default preloaded helpers (the core four, matching what guest.py injects). */
export const CORE_HELPERS = ["read", "write", "bash", "glob", "sh"] as const;

export interface ReplConfig {
	/** Helper function names to preload into the kernel + mention in the prompt. */
	helpers: string[];
	/** Python interpreter used to spawn the guest. Defaults to the venv / PATH. */
	pythonPath?: string;
	/** Directory of toolbox function files, exec'd into every kernel. */
	toolsDir?: string;
	/** Per-cell execution timeout, ms. Default 60_000. */
	timeoutMs: number;
	/** Debounce for the auto-snapshot after an ok cell, ms. Default 1500. */
	snapshotDebounceMs: number;
	/** Max subagent recursion depth. Default 2. */
	maxDepth: number;
}

const DEFAULT_CONFIG: ReplConfig = {
	helpers: [...CORE_HELPERS],
	timeoutMs: 60_000,
	snapshotDebounceMs: 1500,
	maxDepth: 2,
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

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
			if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
			let helpers = [...DEFAULT_CONFIG.helpers];
			if (raw.helpers !== undefined) {
				if (!Array.isArray(raw.helpers)) return { ...DEFAULT_CONFIG };
				helpers = raw.helpers.filter((h): h is string => typeof h === "string");
			}
			return {
				helpers,
				pythonPath: typeof raw.pythonPath === "string" && raw.pythonPath.length > 0 ? raw.pythonPath : undefined,
				toolsDir: typeof raw.toolsDir === "string" && raw.toolsDir.length > 0 ? raw.toolsDir : undefined,
				timeoutMs: num(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs),
				snapshotDebounceMs: num(raw.snapshotDebounceMs, DEFAULT_CONFIG.snapshotDebounceMs),
				maxDepth: num(raw.maxDepth, DEFAULT_CONFIG.maxDepth),
			};
		} catch {}
	}
	return { ...DEFAULT_CONFIG };
}

/** Readable source path for debugging/notifications. */
export function activeConfigSource(): string {
	for (const file of configCandidates()) {
		if (file && existsSync(file)) return file;
	}
	return "(default in-code config)";
}
