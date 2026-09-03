// --- state lives at ~/.pi/agent/pi-repl/state/<slug>__<conv>: legacy bare-name dirs migrate on the owning conversation's next start, and the sweep knows both formats, so nothing live is swept and a deleted conversation loses its snapshots ---
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function conversationName(sessionFile: string): string {
	return basename(sessionFile).replace(/\.jsonl$/, "");
}

/** Slug-keyed dir name: conversations whose files share a basename can never share a snapshot. */
export function sessionStateDirName(sessionFile: string): string {
	return `${basename(dirname(sessionFile))}__${conversationName(sessionFile)}`;
}

function legacyStateDirName(sessionFile: string): string {
	return conversationName(sessionFile);
}

/** Resolve the state dir, migrating a legacy bare-name dir on first start — whichever conversation starts first owns the legacy dir; the other starts empty. */
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
