/**
 * Subagent host handlers: `rlm.run` / `rlm.list_subagents` / `rlm.delete_subagent`.
 *
 * Spawning returns as soon as the child is admitted, never when it is done: a
 * parent that blocked on its children could not supervise them, and a handle is
 * useful immediately while an answer is not. Results therefore arrive through
 * the filesystem — each child's final output is written to
 * `<subagentDir>/<child_id>.output.md` — and the registry reports whether a
 * child is running, completed, or errored so the parent can decide when to read.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { HostRequestHandlers } from "../engine/index.js";

export type SubagentStatus = "running" | "completed" | "error";

export interface SubagentEntry {
	rlm_child_id: string;
	session_name: string;
	session_dir: string;
	output_file: string;
	model: string;
	status: SubagentStatus;
	exit_code: number | null;
	pid: number | undefined;
}

export interface SubagentHostOptions {
	cwd: string;
	/** Directory for child session files and output files. */
	subagentDir: string;
	/** provider/model for children unless kwargs.model overrides. */
	defaultModel: string;
	/** Recursion depth of THIS agent; children get depth + 1. */
	depth: number;
	maxDepth: number;
	/** Override the spawned command for tests. Receives the fully built args. */
	spawnCommand?: (entry: SubagentEntry, prompt: string) => { command: string; args: string[] };
}

export const MAX_SUBAGENT_NAME_LENGTH = 64;

export function defaultSubagentName(prompt: string, childId: string): string {
	const slug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const suffix = childId.replace(/[^a-z0-9]/gi, "").slice(-8) || "child";
	const fixed = "subagent--".length + suffix.length;
	const promptPart = (slug || "worker").slice(0, Math.max(1, MAX_SUBAGENT_NAME_LENGTH - fixed)).replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${suffix}`;
}

export interface SubagentHost {
	handlers: HostRequestHandlers;
	entries(): SubagentEntry[];
	killAll(): void;
}

export function createSubagentHost(options: SubagentHostOptions): SubagentHost {
	const registry = new Map<string, SubagentEntry>();
	const children = new Map<string, ReturnType<typeof spawn>>();

	function toPublicEntry(entry: SubagentEntry): Record<string, unknown> {
		// One name for one concept: rlm.run replies with `name`, so the registry
		// must too — a poll that matches on `entry.name` has to work. (It did
		// not, and the resulting waits timed out silently instead of detecting
		// completion.)
		return {
			rlm_child_id: entry.rlm_child_id,
			name: entry.session_name,
			session_dir: entry.session_dir,
			output_file: entry.output_file,
			model: entry.model,
			status: entry.status,
		};
	}

	const handlers: HostRequestHandlers = {
		"rlm.run": async (payload) => {
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				throw new Error("rlm.run prompt must be a non-empty string");
			}
			if (options.depth + 1 > options.maxDepth) {
				throw new Error(`rlm.run refused: recursion depth limit (${options.maxDepth}) reached`);
			}
			const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
			const requestedName = kwargs.name;
			if (requestedName !== undefined && typeof requestedName !== "string") {
				throw new Error("rlm.run name must be a string");
			}
			if (typeof requestedName === "string" && requestedName.length > MAX_SUBAGENT_NAME_LENGTH) {
				throw new Error(`rlm.run name must be at most ${MAX_SUBAGENT_NAME_LENGTH} characters`);
			}
			const model = typeof kwargs.model === "string" && kwargs.model ? kwargs.model : options.defaultModel;

			const childId = `sub-${randomUUID()}`;
			const name = requestedName?.trim() || defaultSubagentName(prompt, childId);
			mkdirSync(options.subagentDir, { recursive: true });
			const outputFile = join(options.subagentDir, `${childId}.output.md`);

			const entry: SubagentEntry = {
				rlm_child_id: childId,
				session_name: name,
				session_dir: options.subagentDir,
				output_file: outputFile,
				model,
				status: "running",
				exit_code: null,
				pid: undefined,
			};

			const spec = options.spawnCommand
				? options.spawnCommand(entry, prompt)
				: {
						command: "pi",
						args: [
							"-p",
							"--no-extensions",
							"-e",
							join(import.meta.dirname, "index.ts"),
							"--provider",
							model.includes("/") ? model.slice(0, model.indexOf("/")) : "anthropic",
							"--model",
							model.includes("/") ? model.slice(model.indexOf("/") + 1) : model,
							"--session-dir",
							options.subagentDir,
							"--name",
							name,
							prompt,
						],
					};

			const outFd = openSync(outputFile, "w");
			const child = spawn(spec.command, spec.args, {
				cwd: options.cwd,
				detached: false,
				stdio: ["ignore", outFd, outFd],
				// PI_RLM_FORCE activates the child regardless of flag plumbing: the
				// child loads this extension via -e and must enter the RLM world
				// without depending on --rlm surviving pi's argv handling.
				env: { ...process.env, PI_RLM_DEPTH: String(options.depth + 1), PI_RLM_FORCE: "1" },
			});
			closeSync(outFd);
			entry.pid = child.pid;
			registry.set(childId, entry);
			children.set(childId, child);

			child.on("exit", (code) => {
				entry.exit_code = code;
				entry.status = code === 0 ? "completed" : "error";
				children.delete(childId);
			});
			child.on("error", () => {
				entry.status = "error";
				children.delete(childId);
			});

			// Admission: return the handle immediately; results land in output_file.
			return {
				rlm_child_id: childId,
				name,
				session_dir: options.subagentDir,
				output_file: outputFile,
				model,
			};
		},

		"rlm.list_subagents": async () => {
			return { subagents: [...registry.values()].map(toPublicEntry) };
		},

		"rlm.delete_subagent": async (payload) => {
			const target = typeof payload.target === "string" ? payload.target.trim() : "";
			if (!target) throw new Error("rlm.delete_subagent target must be a non-empty string");
			const entry =
				registry.get(target) ?? [...registry.values()].find((candidate) => candidate.session_name === target);
			if (!entry) throw new Error(`rlm.delete_subagent: no subagent matches "${target}"`);
			const child = children.get(entry.rlm_child_id);
			if (child) {
				child.kill("SIGTERM");
				children.delete(entry.rlm_child_id);
				entry.status = "error";
			}
			registry.delete(entry.rlm_child_id);
			return { subagent: toPublicEntry(entry) };
		},
	};

	return {
		handlers,
		entries: () => [...registry.values()],
		killAll: () => {
			for (const child of children.values()) child.kill("SIGKILL");
			children.clear();
		},
	};
}
