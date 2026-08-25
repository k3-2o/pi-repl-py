// --- pi-repl: one execute tool over Python; everything else runs as functions inside it ---

import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { withSkillsBlock } from "./src/extension/skill-hook.js";
import { EngineManager } from "./src/engine/index.js";
import { ExecuteCellComponent, type ExecuteDetails, type ExecuteRenderState } from "./src/extension/render.js";
import { EngineLifecycle } from "./src/extension/session-engine.js";
import { EXECUTE_DESCRIPTION, buildExecutePromptGuidelines, EXECUTE_PROMPT_SNIPPET } from "./src/extension/tool-meta.js";

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
			// --- kernel namespace state lives under ~/.pi/agent/pi-repl, keyed by session, so it never clutters the project ---
			const stateDir = join(homedir(), ".pi", "agent", "pi-repl", "state", sessionKey ?? "ephemeral");
			return new EngineManager({
				cwd,
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

	// --- no custom prompt: pi's default prompt stands; active tools collapse to execute, so REPL knowledge lives on the tool ---

	pi.on("session_start", async (_event, ctx) => {
		if (!active()) {
			// --- drop execute so a stock session stays stock ---
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "execute"));
			return;
		}
		// --- active: the whole surface collapses to the one tool ---
		pi.setActiveTools(["execute"]);
		// --- warm the engine (and its revive) in the background; no popup. ---
		// --- acquire() dedupes, so the first execute awaits this same in-flight boot ---
		location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined };
		void lifecycle.acquire("startup").catch(() => {
			// --- boot/revive handled on the execute path; swallow so a background warm can never
			// --- surface an unhandled rejection and the model never needs the restore notice ---
		});
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

	// --- pi gates skills on the read tool (absent in repl); re-emit them via withSkillsBlock. ---
	pi.on("before_agent_start", (event) => {
		if (!active()) return;
		const systemPrompt = withSkillsBlock(
			event.systemPrompt,
			event.systemPromptOptions?.skills ?? [],
		);
		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	pi.registerTool<typeof executeSchema, ExecuteDetails, Partial<ExecuteRenderState>>({
		name: "execute",
		label: "execute",
		description: EXECUTE_DESCRIPTION,
		promptSnippet: EXECUTE_PROMPT_SNIPPET,
		promptGuidelines: buildExecutePromptGuidelines(process.cwd()),
		parameters: executeSchema,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = syncRenderState(context.state, { ...context, args });
			state.version = (state.version ?? 0) + 1;
			// --- compact header lives in the call slot ---
			return new ExecuteCellComponent(state, theme, "header");
		},
		renderResult(result, options, _theme, context) {
			const state = syncRenderState(context.state, context);
			state.version = (state.version ?? 0) + 1;
			state.hasResult = true;
			state.isPartial = options.isPartial;
			state.expanded = options.expanded;
			state.details = (result.details as ExecuteDetails | undefined) ?? state.details;
			state.contentText = result.content
				?.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// --- body (code + output) lives in the result slot; Ctrl+O expands it ---
			return new ExecuteCellComponent(state, _theme, "body");
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!active()) {
				throw new Error("pi-repl is dormant in this session. Start pi with --repl (or PI_REPL_FORCE=1) to use execute.");
			}
			if (ctx?.cwd) location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined };
			// --- establish the body slot at call time so Ctrl+O can expand a live (still-awaiting) stream;
			// --- without this the host only renders the result once the first partial or the final result lands ---
			onUpdate?.({ content: [], details: {} });
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
			// --- an aborted cell was interrupted, not wedged: the kernel keeps running, nothing to discard ---
			return result;
		} catch (error) {
			// --- a kernel that died (or was killed as the abort backstop) is down; drop it so the next cell rebuilds ---
			if (m.isRunning === false) {
				await lifecycle.discard();
			}
			throw error;
		}
		},
	});
}
