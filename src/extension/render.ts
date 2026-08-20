/** TUI adapter binding pi's theme/width to the unit-tested pure layout in render-core.ts. */

import { highlightCode, keyHint, keyText, rawKeyHint, type Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	type BgKind,
	type ExecuteRenderState,
	type RenderDeps,
	renderExecuteBody,
	renderExecuteCell,
	renderExecuteHeader,
	statusKind,
} from "./render-core.js";

export type { ExecuteDetails, ExecuteRenderState } from "./render-core.js";

function makeDeps(theme: Theme): RenderDeps {
	return {
		fg: (color, text) => theme.fg(color as Parameters<Theme["fg"]>[0], text),
		getBgAnsi: (bg: BgKind) => theme.getBgAnsi(bg),
		highlight: (code) => highlightCode(code, "python"),
		keyHint: (expanded) => {
			const text = expanded ? "to collapse" : "to expand";
			const key = keyText("app.tools.expand");
			return key ? keyHint("app.tools.expand", text) : rawKeyHint("ctrl+o", text);
		},
		visibleWidth,
		truncateToWidth,
		wrapTextWithAnsi,
	};
}

/** The layout only changes on state/spinner change, but the TUI repaints every frame; key by both to avoid recompute flicker. */
function renderVersion(state: ExecuteRenderState): string {
	const details = state.details ? JSON.stringify(state.details) : "";
	return [
		state.code.length,
		state.contentText?.length ?? 0,
		details.length,
		state.isPartial,
		state.isError,
		state.expanded,
		state.executionStarted,
		state.hasResult,
		// --- fold the animation frame in while running so the spinner still turns ---
		statusKind(state) === "running" ? Math.floor(Date.now() / 120) % 4 : -1,
	].join("|");
}

export class ExecuteCellComponent {
	private readonly deps: RenderDeps;
	private cachedKey = "";
	private cachedWidth = -1;
	private cachedLines?: string[];

	constructor(
		private readonly state: ExecuteRenderState,
		theme: Theme,
		private readonly mode: "cell" | "header" | "body" = "cell",
	) {
		this.deps = makeDeps(theme);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const key = `${renderVersion(this.state)}|${this.mode}`;
		if (this.cachedLines && this.cachedWidth === width && this.cachedKey === key) {
			return this.cachedLines;
		}
		const lines =
			this.mode === "header"
				? renderExecuteHeader(this.state, width, this.deps)
				: this.mode === "body"
					? renderExecuteBody(this.state, width, this.deps)
					: renderExecuteCell(this.state, width, this.deps);
		this.cachedKey = key;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
