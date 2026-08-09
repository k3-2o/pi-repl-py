// --- preview entry: score the whole cell for its one truthful line ---

import {
	agentCandidates,
	bridgedToolCandidates,
	fileCandidates,
	genericCandidates,
	shellCandidates,
} from "./candidates.js";
import { descriptor } from "./descriptor.js";
import { stringConsts } from "./scan.js";
import { previewShellCommand } from "./shell.js";
import type { CellPreview } from "./types.js";

export type { CellPreview };
export { descriptor, previewShellCommand };

export function previewCell(code: string): CellPreview {
	const source = code.trimEnd();
	if (!source) return { kind: "ts", text: "" };
	const vars = stringConsts(source);

	// --- scan order matters: agent masks shell-looking syntax before the shell scan ---
	const agent = agentCandidates(source, vars);
	const shell = shellCandidates(agent.masked, vars);
	const candidates = [
		...agent.candidates,
		...shell.candidates,
		...fileCandidates(shell.masked, vars),
		...bridgedToolCandidates(shell.masked, vars),
		...genericCandidates(shell.masked),
	];

	let best: { kind: CellPreview["kind"]; text: string; score: number } | undefined;
	for (const candidate of candidates) {
		if (candidate.text && (!best || candidate.score > best.score)) best = candidate;
	}
	return best ?? { kind: "ts", text: "" };
}
