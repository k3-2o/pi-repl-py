import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./prompt.js";

export const EXECUTE_DESCRIPTION = executeToolDescription;
export const EXECUTE_PROMPT_SNIPPET = executePromptSnippet;

// --- static guidelines only; the per-session helper roster is spliced into the system prompt (helpers.ts) ---
export function buildExecutePromptGuidelines(): string[] {
	// --- static guidelines carry no concrete roster: a registration-time list would freeze the
	// --- launch cwd's helpers forever (the resume bug). The same wording is emitted per session
	// --- into the system prompt (helpers.ts), where the real list can be current. ---
	return buildPromptGuidelines([]);
}
