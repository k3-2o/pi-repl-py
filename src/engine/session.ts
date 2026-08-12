// --- Jupyter messaging over ZMTP: [identities] <IDS|MSG> [sig, h, p, m, c] ---
// ids are empty for a client's own channels (kernel ROUTER strips them);
// sig = hex(HMAC-SHA256(key, h||p||m||c)) over the exact bytes; key from the
// connection file. Checked against jupyter_client's session.py.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** The kernel's connection file: ip/ports/key, written by ipykernel at boot. */
export interface ConnectionFile {
	ip: string;
	transport: "tcp" | "ipc";
	shell_port: number;
	iopub_port: number;
	stdin_port: number;
	control_port: number;
	hb_port: number;
	key: string;
	signature_scheme: string;
	kernel_name?: string;
}

export function readConnectionFile(path: string): ConnectionFile {
	return JSON.parse(readFileSync(path, "utf8")) as ConnectionFile;
}

const DELIM = Buffer.from("<IDS|MSG>");
/** The protocol version ipykernel 7 advertises; we send the same on our own headers. */
const PROTOCOL_VERSION = "5.3";

export interface JupyterHeader {
	msg_id: string;
	msg_type: string;
	username: string;
	session: string;
	date: string;
	version: string;
}

/** A parsed inbound message: JSON parts + whether the signature verified. */
export interface ParsedMessage {
	msg_id: string;
	msg_type: string;
	header: JupyterHeader;
	parent: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
	signatureOk: boolean;
}

function pack(obj: unknown): Buffer {
	return Buffer.from(JSON.stringify(obj));
}

/** One client-side session: mints ids, signs and frames outbound messages. */
export class JupyterSession {
	readonly sessionId: string;
	readonly username: string;
	private counter = 0;
	private readonly key: Buffer;

	constructor(opts: { key: string; sessionId?: string; username?: string }) {
		this.key = Buffer.from(opts.key, "utf8");
		this.sessionId = opts.sessionId ?? randomUUID();
		this.username = opts.username ?? "pi-repl";
	}

	nextMsgId(): string {
		// --- ids only need uniqueness; a monotone counter over a session id keeps them short ---
		return `${this.sessionId}_${process.pid}_${this.counter++}`;
	}

	private sign(parts: Buffer[]): Buffer {
		if (this.key.length === 0) return Buffer.alloc(0);
		const hmac = createHmac("sha256", this.key);
		for (const part of parts) hmac.update(part);
		return Buffer.from(hmac.digest("hex"), "ascii");
	}

	/** Build the wire frames for an outbound message: [DELIM, sig, h, p, m, c]. */
	buildFrames(
		msgType: string,
		content: Record<string, unknown>,
		parent?: JupyterHeader | null,
		msgId?: string,
	): Buffer[] {
		const header: JupyterHeader = {
			msg_id: msgId ?? this.nextMsgId(),
			msg_type: msgType,
			username: this.username,
			session: this.sessionId,
			date: new Date().toISOString(),
			version: PROTOCOL_VERSION,
		};
		const h = pack(header);
		const p = pack(parent ?? {});
		const m = pack({});
		const c = pack(content);
		const signature = this.sign([h, p, m, c]);
		return [DELIM, signature, h, p, m, c];
	}

	/** Parse an inbound multipart message (identities stripped by ZMTP); null if malformed. */
	parseMessage(frames: Buffer[]): ParsedMessage | null {
		// --- indexOf uses ===; frames are distinct Buffers, so match by value ---
		const delimIdx = frames.findIndex((f) => f.equals(DELIM));
		if (delimIdx < 0) return null;
		const rest = frames.slice(delimIdx + 1);
		if (rest.length < 5) return null;
		const [signature, h, p, m, c] = rest;
		const expected = this.sign([h, p, m, c]);
		const signatureOk = this.key.length === 0 || signature.equals(expected);
		try {
			const header = JSON.parse(h.toString("utf8")) as JupyterHeader;
			const content = JSON.parse(c.toString("utf8")) as Record<string, unknown>;
			const metadata = JSON.parse(m.toString("utf8")) as Record<string, unknown>;
			const parent = JSON.parse(p.toString("utf8")) as Record<string, unknown>;
			return { msg_id: header.msg_id, msg_type: header.msg_type, header, parent, metadata, content, signatureOk };
		} catch {
			return null;
		}
	}
}

export function executeRequest(code: string, silent: boolean): Record<string, unknown> {
	return {
		code,
		silent,
		store_history: !silent,
		user_expressions: {},
		allow_stdin: false,
		stop_on_error: true,
	};
}

/** A payload the kernel publishes back to us with a private MIME key. */
export const SNAPSHOT_MIME = "application/vnd.pi-repl.snapshot+json";
export const RESTORE_MIME = "application/vnd.pi-repl.restore+json";
export const NAMES_MIME = "application/vnd.pi-repl.names+json";

/** Read a private-MIME payload out of an execute_result/display_data content. */
export function readPayload(content: Record<string, unknown>, mime: string): string | null {
	const data = content.data;
	if (data && typeof data === "object") {
		const value = (data as Record<string, unknown>)[mime];
		if (typeof value === "string") return value;
	}
	return null;
}
