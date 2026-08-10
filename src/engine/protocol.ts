// --- trust: fd3 is protocol-only (user output stays on stdout), and a cell can't forge frames (minted nonce) ---

interface HostToGuest {
	run: { type: "run"; cellId: string; code: string };
	abort: { type: "abort"; cellId: string };
	ping: { type: "ping"; id: string };
	snapshot: { type: "snapshot"; id: string };
	restore: { type: "restore"; id: string; vars: Record<string, string> };
	list_names: { type: "list_names"; id: string };
}

export type HostToGuestMessage = HostToGuest[keyof HostToGuest];

// --- one nested tool call recorded by the guest; opaque to the protocol ---
export interface AuditEntry {
	ref: string;
	args?: Record<string, unknown>;
	result?: unknown;
	success?: boolean;
	error?: string;
	startedAt?: number;
	endedAt?: number;
}

interface GuestToHost {
	ready: { type: "ready" };
	stream: { type: "stream"; cellId: string; name: "stdout" | "stderr"; chunk: string };
	done: {
		type: "done";
		cellId: string;
		status: "ok" | "error" | "aborted";
		result?: string;
		audits?: AuditEntry[];
		error?: { name: string; message: string; stack: string[] };
	};
	pong: { type: "pong"; id: string };
	snapshot_result: {
		type: "snapshot_result";
		id: string;
		vars: Record<string, string>;
		failed: { name: string; reason: string }[];
		/** False means the kernel didn't finish serializing; keep the last good file. */
		complete?: boolean;
	};
	restore_result: {
		type: "restore_result";
		id: string;
		restored: string[];
		failed: { name: string; reason: string }[];
	};
	names_result: { type: "names_result"; id: string; names: string[] };
}

export type GuestToHostMessage = GuestToHost[keyof GuestToHost];

const ENVELOPE_KEY = "__rlm";
/** Env var carrying the per-process nonce to the guest. */
export const NONCE_ENV = "PI_RLM_NONCE";
/** Protocol pipe: guest → host. */
export const PROTOCOL_FD = 3;

export function encodeMessage(message: HostToGuestMessage | GuestToHostMessage, nonce?: string): string {
	const envelope: Record<string, unknown> = { [ENVELOPE_KEY]: 1, ...message };
	if (nonce) envelope.n = nonce;
	return `${JSON.stringify(envelope)}\n`;
}

export function decodeMessage<T>(line: string, nonce?: string): T | null {
	if (!line.trim()) return null;
	try {
		const parsed = JSON.parse(line);
		if (parsed?.[ENVELOPE_KEY] !== 1 || typeof parsed.type !== "string") return null;
		if (nonce && parsed.n !== nonce) return null;
		return parsed as T;
	} catch {
		return null;
	}
}
