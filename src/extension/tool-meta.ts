// --- tool-meta: thin surface assembling the execute tool's prompt from pure modules ---
// --- the model contract lives in prompt.ts; only the helpers wiring stays here ---

import { buildHelpersMap } from "./helpers.js";
import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./prompt.js";

export const EXECUTE_DESCRIPTION = executeToolDescription;
export const EXECUTE_PROMPT_SNIPPET = executePromptSnippet;

// --- build the guidelines from the helpers dir, falling back when nothing is preloaded ---
export function buildExecutePromptGuidelines(helpersDir?: string): string[] {
	const map = buildHelpersMap(helpersDir);
	const preloaded = map.length > 0 ? map : ["(no helpers preloaded yet — build your own)"];
	return buildPromptGuidelines(preloaded);
}
