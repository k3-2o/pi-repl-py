// --- preview entry: score the whole cell for its one truthful line ---

import { genericCandidates, pythonFileCandidates } from "./candidates.js";
import { descriptor } from "./descriptor.js";
import type { CellPreview } from "./types.js";

export type { CellPreview };
export { descriptor };

export function previewCell(code: string): CellPreview {
	const source = code.trimEnd();
	if (!source) return { text: "" };
	// --- file effects carry the most signal; generic line shape fills the rest ---
	const candidates = [...pythonFileCandidates(source), ...genericCandidates(source)];

	let best: { text: string; score: number } | undefined;
	for (const candidate of candidates) {
		if (candidate.text && (!best || candidate.score > best.score)) best = candidate;
	}
	return best ?? { text: "" };
}
