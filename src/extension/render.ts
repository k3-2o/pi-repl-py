/**
 * TUI adapter for the `execute` cell renderer.
 *
 * Binds pi's theme, syntax highlighting, key hints, and width primitives to the
 * pure layout in render-core.ts, which is unit-tested outside pi's runtime.
 */

import { highlightCode, keyHint, type Theme } from "@mariozechner/pi-coding-agent";
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
		highlight: (line) => highlightCode(line, "typescript")[0] ?? line,
		keyHint: (expanded) => keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
		visibleWidth,
		truncateToWidth,
		wrapTextWithAnsi,
	};
}

/**
 * The layout of a cell only changes when its state or the spinner frame does,
 * but the TUI repaints on every frame. Rendering from a key of both stops the
 * recompute-per-frame (and with it, flicker on wide panes).
 */
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
		statusKind(state) === "running" ? Math.floor(Date.now() / 160) % 4 : -1,
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
