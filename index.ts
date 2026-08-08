/**
 * pi-repl: Python REPL engine for pi.
 *
 * A single LLM-facing tool, `execute`, running Python in a persistent evaluator.
 * Everything else — shell, files, custom toolbox functions — is expressed as
 * code inside that tool rather than as more pi tools, which is what lets
 * capabilities grow without changing the interface the model sees.
 */

import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { EngineBusyError, EngineManager } from "./src/engine/index.js";
import { loadConfig } from "./src/extension/config.js";
import { buildRlmPyPrompt, buildToolboxListing } from "./src/extension/prompt.js";
import { ExecuteCellComponent, type ExecuteDetails, type ExecuteRenderState } from "./src/extension/render.js";
import { EngineLifecycle, summarizeNames } from "./src/extension/session-engine.js";

const executeSchema = Type.Object({
	code: Type.String({
		description: "Python to execute in the persistent evaluator.",
	}),
});

function syncRenderState(
	state: Partial<ExecuteRenderState>,
	context: {
		args?: { code?: string };
		isPartial: boolean;
		isError: boolean;
		expanded: boolean;
		executionStarted: boolean;
	},
): ExecuteRenderState {
	state.code = context.args?.code ?? state.code ?? "";
	state.isPartial = context.isPartial;
	state.isError = context.isError;
	state.expanded = context.expanded;
	state.executionStarted = context.executionStarted;
	state.hasResult = state.hasResult ?? false;
	return state as ExecuteRenderState;
}

/** Stack lines kept when surfacing a cell error to the model. */
const ERROR_STACK_LINES = 10;

/** Header plus stack — without repeating the header when the stack already starts with it. */
function composeErrorLines(error: { name: string; message: string; stack: string[] }): string[] {
	const header = `${error.name}: ${error.message}`;
	const stack = error.stack.slice(0, ERROR_STACK_LINES);
	return stack[0]?.trim() === header ? stack : [header, ...stack];
}

const CFG = loadConfig();

export default function (pi: ExtensionAPI) {
	pi.registerFlag("repl", {
		type: "boolean",
		description: "Single execute tool backed by a persistent Python evaluator; replaces the default tool surface",
	});
	// Flag only lands post-factory; gate per event. PI_REPL_FORCE is the dev escape.
	const active = () => pi.getFlag("repl") === true || process.env.PI_REPL_FORCE === "1";

	let location = { cwd: process.cwd(), sessionFile: undefined as string | undefined };
	// Pi rebuilds thrown errors as bare text; stash details to re-attach in tool_result.
	const pendingErrorResults = new Map<string, { details: ExecuteDetails }>();

	const lifecycle = new EngineLifecycle<EngineManager>({
		create() {
			const { cwd, sessionFile } = location;
			const sessionKey = sessionFile ? basename(sessionFile).replace(/\.jsonl$/, "") : undefined;
			const stateDir = join(cwd, ".pi-repl", sessionKey ?? "ephemeral");
			return new EngineManager({
				cwd,
				pythonPath: CFG.pythonPath,
				timeoutMs: CFG.timeoutMs,
				toolboxDir: CFG.toolboxDir,
				// --- snapshots are keyed to a session file; ephemeral sessions get none ---
				snapshot: sessionKey ? { path: join(stateDir, "namespace.snapshot") } : undefined,
			});
		},
		async dispose(engine) {
			await engine.dispose();
		},
		// --- a wedged guest can't answer dispose; kill and rely on the last snapshot ---
		async discard(engine) {
			await engine.kill();
		},
	});

	// --- replace pi's default prompt (it advertises tools we don't register) ---
	pi.on("before_agent_start", async (event, ctx) => {
		if (!active()) return undefined; // --- dormant: stock prompt + stock tools stand ---
		const options = (event as { systemPromptOptions?: { contextFiles?: Array<{ path: string; content: string }> } })
			.systemPromptOptions;
		return {
			systemPrompt: buildRlmPyPrompt({
				cwd: ctx.cwd,
				contextFiles: options?.contextFiles,
				toolboxDir: CFG.toolboxDir,
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!active()) {
			// --- drop execute so a stock session stays stock ---
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "execute"));
			return;
		}
		// --- active: the whole surface collapses to the one tool ---
		pi.setActiveTools(["execute"]);
		// --- revive the previous run; the engine also self-revives if session_start was skipped ---
		location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined };
		const { restore } = await lifecycle.acquire("startup");
		if (restore && restore.restored.length > 0) {
			pi.sendMessage({
				customType: "pi-repl-restore",
				content: `Revived ${restore.restored.length} variable(s) from the previous run: ${summarizeNames(restore.restored, 8)}${
					restore.failed.length > 0
						? `. Failed: ${summarizeNames(
								restore.failed.map((f) => f.name),
								8,
							)}`
						: ""
				}`,
				display: true,
			});
		}
	});

	pi.on("session_shutdown", async () => {
		await lifecycle.shutdown();
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "execute") return undefined;
		const stashed = pendingErrorResults.get(event.toolCallId);
		pendingErrorResults.delete(event.toolCallId);
		if (!stashed || !event.isError) return undefined;
		// --- restore the collapsed details an errored cell lost ---
		return { content: event.content, details: stashed.details, isError: true };
	});

	pi.registerTool<typeof executeSchema, ExecuteDetails, Partial<ExecuteRenderState>>({
		name: "execute",
		label: "execute",
		description:
			"Execute Python in a persistent evaluator. Variables, imports, and loaded data persist across calls. " +
			`Toolbox functions are preloaded: ${buildToolboxListing(CFG.toolboxDir)}. ` +
			"Use ls() / help(name) to discover them. The final expression of the cell is returned as the result.",
		parameters: executeSchema,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = syncRenderState(context.state, { ...context, args });
			return new ExecuteCellComponent(state, theme);
		},
		renderResult(result, options, _theme, context) {
			const state = syncRenderState(context.state, context);
			state.hasResult = true;
			state.isPartial = options.isPartial;
			state.expanded = options.expanded;
			state.details = (result.details as ExecuteDetails | undefined) ?? state.details;
			state.contentText = result.content
				?.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// --- the call slot renders the whole cell, result slot adds nothing ---
			return { render: () => [], invalidate: () => {} };
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!active()) {
				throw new Error("pi-repl is dormant in this session. Start pi with --repl (or PI_REPL_FORCE=1) to use execute.");
			}
			if (ctx?.cwd) location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined };
			// --- previous engine died mid-session; acquire revives it ---
			const { engine: m } = await lifecycle.acquire("cell");
			try {
				// --- accumulate partial updates so the row height doesn't oscillate ---
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				// --- reset notice leads so the model reads that its namespace was rebuilt ---
				const sections = [lifecycle.takeResetNotice(), r.stdout, r.stderr, r.result];
				const errorLines = r.error ? composeErrorLines(r.error) : undefined;
				if (r.status === "error" && errorLines) sections.push(errorLines.join("\n"));
				if (r.status === "aborted") sections.push("[cell aborted]");
			const text = sections.filter((section) => section !== undefined && section !== "").join("\n");

			const details: ExecuteDetails = {
				status: r.status,
				durationMs: r.durationMs,
				errorName: r.error?.name,
				stdout: r.stdout || undefined,
				stderr: r.stderr || undefined,
				result: r.result,
				errorStack: errorLines,
			};
			const result = { content: [{ type: "text" as const, text: text || "(no output)" }], details };
			if (r.status === "error") {
				pendingErrorResults.set(toolCallId, { details });
				throw new Error(text || "(no output)");
			}
			return result;
		} catch (error) {
			if (error instanceof EngineBusyError) {
				// --- discard the wedged engine; the next cell revives from the last snapshot ---
				await lifecycle.discard();
				throw new Error(
					"The evaluator was wedged by a previously interrupted cell and has been killed. " +
						"Run the next cell to get a fresh evaluator revived from the last snapshot; " +
						"anything newer than that snapshot is gone, so re-verify variables before reusing them.",
				);
			}
			// --- a guest that died leaves the engine shutdown; drop it so the next cell rebuilds fresh ---
			if (m.isRunning === false) {
				await lifecycle.discard();
			}
			throw error;
		}
		},
	});
}
