// --- where a conversation's kernel state lives: ~/.pi/agent/pi-repl/state/<key>.
// --- Keys must never collide across conversations, so the project-root slug joins the
// --- conversation name. Pre-slug legacy dirs (bare name) migrate to the slug key on the
// --- owning conversation's next start; the orphan sweep still recognizes both formats,
// --- so nothing live is ever swept and a deleted conversation loses all its snapshots. ---
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The conversation's own name: the session file's basename without .jsonl (unique per conversation). */
export function conversationName(sessionFile: string): string {
	return basename(sessionFile).replace(/\.jsonl$/, "");
}

/** Slug-keyed state dir name: unique among all conversations under one sessions root, so two
 * conversations whose files happen to share a basename (copied/renamed session files) can never
 * share a snapshot. */
export function sessionStateDirName(sessionFile: string): string {
	return `${basename(dirname(sessionFile))}__${conversationName(sessionFile)}`;
}

/** The pre-slug dir name; still honored when migrating or scanning live conversations. */
function legacyStateDirName(sessionFile: string): string {
	return conversationName(sessionFile);
}

/**
 * Resolve a conversation's state dir and snapshot file, migrating a legacy bare-name dir to the
 * slug key on first start. Two conversations whose files share a basename therefore never share a
 * snapshot file: whichever starts first migrates the legacy dir to its own key; the other starts
 * empty rather than bleeding into the first's namespace.
 */
export function resolveStateDir(stateRoot: string, sessionFile: string): { dir: string; snapshotPath: string } {
	const dir = join(stateRoot, sessionStateDirName(sessionFile));
	const legacy = join(stateRoot, legacyStateDirName(sessionFile));
	const dirSnap = join(dir, "namespace.snapshot");
	const legacySnap = join(legacy, "namespace.snapshot");
	if (legacy !== dir && !existsSync(dirSnap) && existsSync(legacySnap)) {
		try {
			renameSync(legacy, dir); // migrate; a racing rename (another conversation) just falls through
		} catch {
			// the slug dir already exists or the rename raced: keep it; legacy stays until the sweep sees it live or orphaned
		}
	}
	return { dir, snapshotPath: join(dir, "namespace.snapshot") };
}
