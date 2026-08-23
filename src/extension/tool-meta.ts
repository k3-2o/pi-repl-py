// --- tool-meta: thin surface assembling the execute tool's prompt from pure modules ---
// --- the model contract lives in prompt.ts; only the helpers wiring stays here ---

import { buildHelpersMap, buildHelpersMapForCwd } from "./helpers.js";
import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./prompt.js";

export const EXECUTE_DESCRIPTION = executeToolDescription;
export const EXECUTE_PROMPT_SNIPPET = executePromptSnippet;

// --- build the guidelines from the one helpers dir (default ~/.pi/agent/pi-repl/helpers) ---
export function buildExecutePromptGuidelines(cwd?: string): string[] {
	const map = cwd ? buildHelpersMapForCwd(cwd) : buildHelpersMap();
	const preloaded = map.length > 0 ? map : [];
	return buildPromptGuidelines(preloaded);
}
