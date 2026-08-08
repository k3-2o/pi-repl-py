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
	// CLI flag values are injected after extension factories run (verified by
	// probe: getFlag is undefined here, true in every event), so activation is
	// decided per event, never at load. PI_REPL_FORCE is the dev escape hatch:
	// test rigs activate without flag plumbing.
	const active = () => pi.getFlag("repl") === true || process.env.PI_REPL_FORCE === "1";

	let location = { cwd: process.cwd(), sessionFile: undefined as string | undefined };
	// A tool error must be thrown for pi to mark the call as failed, but pi's
	// loop rebuilds thrown errors as bare text results, discarding details and
	// content — and with them the collapsed header's metadata. Recapture them at
	// throw time and re-attach them in the tool_result hook below.
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
				// A snapshot is keyed to a session file; an ephemeral session has none
				// to key it to, so its namespace lives and dies with the process.
				snapshot: sessionKey ? { path: join(stateDir, "namespace.snapshot") } : undefined,
			});
		},
		async dispose(engine) {
			await engine.dispose();
		},
		// A wedged guest cannot answer the snapshot request dispose would send
		// (it would stall for the full request timeout, then fail anyway), so a
		// discard kills outright and relies on the last completed snapshot.
		async discard(engine) {
			await engine.kill();
		},
	});

	// Replace pi's default prompt wholesale. It describes read, bash, and edit
	// tools that this configuration does not register, and a prompt that
	// advertises absent tools is worse than no prompt at all.
	pi.on("before_agent_start", async (event, ctx) => {
		// Dormant: pi's default prompt stands, and it is correct — the builtin
		// tools it describes are actually registered in this configuration.
		if (!active()) return undefined;
		const options = (event as { systemPromptOptions?: { contextFiles?: Array<{ path: string; content: string }> } })
			.systemPromptOptions;
		return {
			systemPrompt: buildRlmPyPrompt({
				cwd: ctx.cwd,
				messagesPath: ctx.sessionManager.getSessionFile() ?? undefined,
				contextFiles: options?.contextFiles,
				toolboxDir: CFG.toolboxDir,
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!active()) {
			// registerTool ran at load (the flag was unreadable then), so a stock
			// session must actively drop execute from the surface to stay stock.
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "execute"));
			return;
		}
		// Active: the whole LLM surface collapses to the one tool.
		pi.setActiveTools(["execute"]);
		// Revive a previous run's namespace before the first cell. This is the
		// expected path, but never the only one: pi skips session_start on reload
		// for extensions like this one, so the engine also revives itself when a
		// cell has to build it. See session-engine.ts.
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
		// Re-attach the collapsed metadata (header details/stack) that pi's loop
		// threw away, so an errored cell still shows its structure.
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
			// The call slot renders the whole cell; the result slot contributes nothing.
			return { render: () => [], invalidate: () => {} };
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!active()) {
				throw new Error("pi-repl is dormant in this session. Start pi with --repl (or PI_REPL_FORCE=1) to use execute.");
			}
			if (ctx?.cwd) location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined };
			// Building the engine here means the previous one went away mid-session;
			// acquire revives it and arms the notice this cell will carry.
			const { engine: m } = await lifecycle.acquire("cell");
			try {
				// Accumulate: partial updates must only ever grow, or the TUI row height
				// oscillates with each replacing chunk (visible as jumping).
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				// A reset notice leads, so the model reads that its namespace was
				// rebuilt before it reads output produced against the rebuilt one.
				// The session_start chat message is not enough: mid-work it scrolls
				// past, and the loss only shows up as a variable reading undefined.
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
					// Recovery is this handler's job, not the model's: keeping the
					// wedged engine cached would make every later cell fail the same
					// way. Discard it; the next cell acquires a fresh engine revived
					// from the last completed snapshot and carries the reset notice.
					await lifecycle.discard();
					throw new Error(
						"The evaluator was wedged by a previously interrupted cell and has been killed. " +
							"Run the next cell to get a fresh evaluator revived from the last snapshot; " +
							"anything newer than that snapshot is gone, so re-verify variables before reusing them.",
					);
				}
				// A guest that died under this cell (process crash, kernel gone)
				// leaves the engine in shutdown. Drop it so the next acquire rebuilds a
				// fresh one from the last snapshot instead of failing forever.
				if (m.isRunning === false) {
					await lifecycle.discard();
				}
				throw error;
			}
		},
	});
}
