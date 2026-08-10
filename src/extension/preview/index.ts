// --- preview entry: score the whole cell for its one truthful line ---

import { bridgedToolCandidates, fileCandidates, genericCandidates, shellCandidates } from "./candidates.js";
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

	// --- scan order: shell masks shell-looking syntax, then file/tool/generic ---
	const shell = shellCandidates(source, vars);
	const candidates = [
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
