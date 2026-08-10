// --- shared preview types; tiny module so every consumer imports only the shape it needs ---
export type CellPreviewKind = "shell" | "ts";

export interface CellPreview {
	kind: CellPreviewKind;
	text: string;
}

// --- a [start, end) slice of the source with its captured body ---
export interface Span {
	start: number;
	end: number;
	body: string;
}

// --- the winner of each detector, ranked by score in the orchestration ---
export interface Candidate {
	kind: CellPreviewKind;
	text: string;
	score: number;
}

export const BACKTICK = "\u0060";
