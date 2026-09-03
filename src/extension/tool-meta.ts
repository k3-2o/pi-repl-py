import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./prompt.js";

export const EXECUTE_DESCRIPTION = executeToolDescription;
export const EXECUTE_PROMPT_SNIPPET = executePromptSnippet;

// --- static guidelines only; the per-session helper roster is spliced into the system prompt (helpers.ts) ---
export function buildExecutePromptGuidelines(): string[] {
	return buildPromptGuidelines();
}
