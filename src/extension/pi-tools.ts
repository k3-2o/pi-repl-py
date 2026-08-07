/**
 * pi's builtin tools, mounted inside the evaluator.
 *
 * The session runs with pi's tools disabled — the model's only tool is
 * `execute`. But the tool implementations themselves (read, bash, edit,
 * write, grep, find, ls) are exported by the pi package as plain
 * ToolDefinitions, so the host can mount them behind the guest bridge: cells
 * call `await tools.read({ path })` and the definition executes host-side
 * with the cell's abort signal.
 *
 * Arguments are validated against each tool's TypeBox schema before execute
 * runs, and a validation failure teaches: it names what was wrong and shows
 * the expected signature. Unknown tool names suggest the nearest real one.
 * Image blocks cannot cross the JSON protocol as pixels a model could see, so
 * they are held host-side and forwarded into the cell's tool-result content;
 * the guest value reports how many.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
import type { HostRequestHandlers } from "../engine/index.js";

/** Structural view of a ToolDefinition; keeps this module decoupled from pi's generics. */
interface MountedTool {
	name: string;
	description: string;
	parameters: {
		required?: string[];
		properties?: Record<string, SchemaProperty>;
	};
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: undefined,
	): Promise<{ content: ContentBlock[]; details: unknown }>;
}

interface SchemaProperty {
	type?: string;
	description?: string;
	items?: { required?: string[]; properties?: Record<string, SchemaProperty> };
}

export interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PiToolsHost {
	handlers: HostRequestHandlers;
	/** Image blocks produced by bridged calls since the last drain. */
	drainImages(): ImageBlock[];
	/** One line per tool: signature plus first sentence of its description. */
	describe(): string[];
}

/**
 * read mixes reader guidance into its text — trailing bracketed notices like
 * "[19 more lines in file. Use offset=4 to continue.]" — which is right for a
 * transcript and wrong for JSON.parse. `raw` is the content alone.
 */
function stripReaderNotices(text: string): string {
	const lines = text.split("\n");
	let removed = false;
	while (lines.length > 0 && /^\[.*\]$/.test(lines[lines.length - 1] ?? "")) {
		lines.pop();
		removed = true;
	}
	// The blank separator only existed to set the notice apart; a file's own
	// trailing blank lines are untouched when nothing was stripped.
	if (removed) while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
	return lines.join("\n");
}

function buildDefinitions(cwd: string): Map<string, MountedTool> {
	const defs = [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	] as unknown as MountedTool[];
	return new Map(defs.map((def) => [def.name, def]));
}

function propertyType(prop: SchemaProperty): string {
	// One level of array-item expansion: "edits: array" invites a wrong guess
	// at the item shape, "edits: [{ oldText: string, newText: string }]" does not.
	if (prop.type === "array" && prop.items?.properties) {
		const itemRequired = new Set(prop.items.required ?? []);
		const fields = Object.entries(prop.items.properties)
			.map(([name, item]) => `${name}${itemRequired.has(name) ? "" : "?"}: ${item.type ?? "unknown"}`)
			.join(", ");
		return `[{ ${fields} }]`;
	}
	return prop.type ?? "unknown";
}

/** `read({ path: string, offset?: number, limit?: number })` — from the schema, so it never drifts. */
function toolSignature(def: MountedTool): string {
	const required = new Set(def.parameters.required ?? []);
	const params = Object.entries(def.parameters.properties ?? {})
		.map(([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${propertyType(prop)}`)
		.join(", ");
	return `${def.name}({ ${params} })`;
}

function firstSentence(text: string): string {
	const line = text.split("\n")[0] ?? "";
	const period = line.indexOf(". ");
	return period > 0 ? line.slice(0, period + 1) : line;
}

function levenshtein(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist = Array.from({ length: rows }, (_, i) => {
		const row = new Array<number>(cols).fill(0);
		row[0] = i;
		return row;
	});
	for (let j = 0; j < cols; j++) dist[0]![j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dist[i]![j] = Math.min(dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1, dist[i - 1]![j - 1]! + cost);
		}
	}
	return dist[rows - 1]![cols - 1]!;
}

function nearestName(name: string, names: Iterable<string>): string | undefined {
	let best: { name: string; distance: number } | undefined;
	for (const candidate of names) {
		const distance = levenshtein(name.toLowerCase(), candidate);
		if (!best || distance < best.distance) best = { name: candidate, distance };
	}
	return best && best.distance <= 3 ? best.name : undefined;
}

function validationError(def: MountedTool, args: unknown): string | undefined {
	if (Value.Check(def.parameters as never, args)) return undefined;
	const problems = [...Value.Errors(def.parameters as never, args)]
		.slice(0, 3)
		.map((error) => (error.instancePath ? `${error.instancePath}: ${error.message}` : error.message))
		.join("; ");
	return `tools.${def.name}: invalid arguments — ${problems}. Expected: ${toolSignature(def)}`;
}

export function createPiToolsHost(options: { cwd: string }): PiToolsHost {
	const definitions = buildDefinitions(options.cwd);
	let pendingImages: ImageBlock[] = [];
	let callCounter = 0;
	// Paths whose full content this session has seen through the bridge: read
	// start-to-finish via tools.read, or written outright via tools.write. Reads
	// inside cell code (Bun.file, readFileSync) are invisible here, which is why
	// the nudge below says "via tools.read" and never accuses. Host-side state:
	// dies with the engine, never snapshotted.
	const fullyKnown = new Set<string>();

	function editNudge(target: string): string {
		return `\nnote: ${target} was never read in full via tools.read this session — partial context risks bad edits.`;
	}

	const handlers: HostRequestHandlers = {
		"tools.call": async (payload, context) => {
			const name = typeof payload.name === "string" ? payload.name : "";
			const def = definitions.get(name);
			if (!def) {
				const suggestion = nearestName(name, definitions.keys());
				const available = [...definitions.keys()].join(", ");
				throw new Error(
					`Unknown tool "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Available: ${available}.`,
				);
			}
			const args = payload.args && typeof payload.args === "object" ? payload.args : {};
			const invalid = validationError(def, args);
			if (invalid) throw new Error(invalid);

			const argPath =
				typeof (args as Record<string, unknown>).path === "string"
					? resolve(options.cwd, (args as Record<string, unknown>).path as string)
					: undefined;
			// Sampled before the write executes: afterwards the file always exists.
			const existedBefore = argPath !== undefined && existsSync(argPath);

			const result = await def.execute(`rlm-tool-${++callCounter}`, args, context?.signal, undefined, undefined);
			let text = result.content
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
			const images = result.content.filter(
				(block): block is ImageBlock =>
					block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
			);
			pendingImages.push(...images);

			if (argPath !== undefined) {
				const record = args as Record<string, unknown>;
				const truncated = Boolean(
					(result.details as { truncation?: { truncated?: boolean } } | null | undefined)?.truncation?.truncated,
				);
				if (name === "read" && record.offset === undefined && record.limit === undefined && !truncated) {
					// Start to finish, nothing cut: the session has seen this file whole.
					fullyKnown.add(argPath);
				}
				if (name === "edit" && !fullyKnown.has(argPath)) {
					text += editNudge(argPath);
				}
				if (name === "write") {
					// Overwriting a file never seen whole earns the nudge; creating a
					// fresh one does not. Either way its content is now ours entirely.
					if (existedBefore && !fullyKnown.has(argPath)) text += editNudge(argPath);
					fullyKnown.add(argPath);
				}
			}

			const reply: Record<string, unknown> = {
				text,
				images: images.length,
				details: (result.details ?? null) as Record<string, unknown> | null,
			};
			if (name === "read") reply.raw = stripReaderNotices(text);
			return reply;
		},
	};

	return {
		handlers,
		drainImages() {
			const drained = pendingImages;
			pendingImages = [];
			return drained;
		},
		describe() {
			return [...definitions.values()].map((def) => `tools.${toolSignature(def)} — ${firstSentence(def.description)}`);
		},
	};
}
