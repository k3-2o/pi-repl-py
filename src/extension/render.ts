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

/** O(1) key: a host-bumped dirty counter plus mode state. `withSpinner` folds
 * the animation frame so the header alone animates while running; the body key
 * excludes it, so a running cell only redraws when output actually changes
 * instead of re-wrapping the whole body every 120ms. */
function renderVersion(state: ExecuteRenderState, withSpinner: boolean): string {
	const spinner = withSpinner && statusKind(state) === "running" ? Math.floor(Date.now() / 120) % 4 : -1;
	return `${state.version ?? 0}|${state.expanded}|${spinner}`;
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
		const key =
			this.mode === "header"
				? `${renderVersion(this.state, true)}|header`
				: this.mode === "body"
					? `${renderVersion(this.state, false)}|body`
					: `${renderVersion(this.state, true)}|cell`;
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
