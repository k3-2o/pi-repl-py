/** A scored preview candidate for one cell in the transcript header. */
export interface Candidate {
	text: string;
	score: number;
}

/** The one-line semantic summary a collapsed cell shows. */
export interface CellPreview {
	text: string;
}
