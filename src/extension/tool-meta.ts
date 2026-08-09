// --- tool-meta: thin surface assembling the execute tool's prompt from pure modules ---
// --- the model contract lives in prompt.ts; only the toolbox wiring stays here ---

import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./prompt.js";
import { buildToolboxMap } from "./toolbox.js";

export const EXECUTE_DESCRIPTION = executeToolDescription;
export const EXECUTE_PROMPT_SNIPPET = executePromptSnippet;

// --- build the guidelines from the toolbox, falling back when nothing is preloaded ---
export function buildExecutePromptGuidelines(toolboxDir?: string): string[] {
	const map = buildToolboxMap(toolboxDir);
	const preloaded = map.length > 0 ? map : ["(none preloaded: define your own)"];
	return buildPromptGuidelines(preloaded);
}
