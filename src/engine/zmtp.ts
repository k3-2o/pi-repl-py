// --- ZMTP 3.0 wire protocol, by hand (bun can't load libzmq's bindings). ---
// DEALER for shell/control, SUB for iopub; greeting 0xff..0x7f + READY each side.

import { connect, type Socket } from "node:net";

const GREETING_SIGNATURE = Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x7f]);
const NULL_MECHANISM = Buffer.concat([Buffer.from("NULL"), Buffer.alloc(16)]);

/** The client (non-server) half of the 64-byte ZMTP 3.0 greeting. */
function buildGreeting(): Buffer {
	return Buffer.concat([
		GREETING_SIGNATURE,
		Buffer.from([3, 0]), // version 3.0
		NULL_MECHANISM,
		Buffer.from([0]), // as-server: we are the connecting socket
		Buffer.alloc(31), // filler
	]);
}

const FRAME_MORE = 0x01;
const FRAME_LONG = 0x02;
const GREETING_LENGTH = 64;

/** Serialize one ZMTP frame: flags byte, short/8-byte length, body. */
export function encodeFrame(body: Uint8Array, more: boolean): Buffer {
	const flags = more ? FRAME_MORE : 0;
	if (body.length <= 255) {
		const out = Buffer.allocUnsafe(2 + body.length);
		out[0] = flags;
		out[1] = body.length;
		Buffer.from(body).copy(out, 2);
		return out;
	}
	const out = Buffer.allocUnsafe(9 + body.length);
	out[0] = flags | FRAME_LONG;
	out.writeUInt32BE(0, 1); // length is 64-bit; we never exceed 2^32
	out.writeUInt32BE(body.length, 5);
	Buffer.from(body).copy(out, 9);
	return out;
}
/** Incremental parser: `current` persists across feed() and accumulation is once-per-frame (avoid O(n²)). */
export class ZmtpFrameParser {
	private chunks: Buffer[] = [];
	private total = 0;
	private current: Buffer[] = []; // frames of the in-progress message

	/** @returns one or more complete messages consumed from `chunk`. */
	feed(chunk: Uint8Array): Buffer[][] {
		if (chunk.length > 0) {
			this.chunks.push(Buffer.from(chunk));
			this.total += chunk.length;
		}
		const messages: Buffer[][] = [];
		for (;;) {
			if (this.total < 1) break;
			const flags = this.peekBytes(1)[0];
			const long = (flags & FRAME_LONG) !== 0;
			const headerLen = long ? 9 : 2;
			if (this.total < headerLen) break;
			const header = this.peekBytes(headerLen);
			const length = long ? header.readUInt32BE(5) : header[1];
			if (this.total < headerLen + length) break;
			const frame = this.take(headerLen + length);
			// `take` returns a subarray (or a fresh concat for multi-chunk frames); never mutated, so no copy
			this.current.push(frame.subarray(headerLen));
			if ((flags & FRAME_MORE) === 0) {
				messages.push(this.current);
				this.current = [];
			}
		}
		return messages;
	}

	/** The first `n` bytes across the chunk list, without consuming them. */
	private peekBytes(n: number): Buffer {
		if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
		const parts: Buffer[] = [];
		let need = n;
		for (const c of this.chunks) {
			const t = Math.min(c.length, need);
			parts.push(c.subarray(0, t));
			need -= t;
			if (need === 0) break;
		}
		return Buffer.concat(parts);
	}

	/** Consume `n` bytes from the front of the chunk list. */
	private take(n: number): Buffer {
		const first = this.chunks[0];
		if (first.length >= n) {
			const out = first.subarray(0, n);
			if (first.length === n) this.chunks.shift();
			else this.chunks[0] = first.subarray(n);
			this.total -= n;
			return out;
		}
		const parts: Buffer[] = [];
		let need = n;
		for (const c of this.chunks) {
			const t = Math.min(c.length, need);
			parts.push(c.subarray(0, t));
			need -= t;
			if (need === 0) break;
		}
		let left = n;
		while (left > 0) {
			const c = this.chunks[0];
			if (c.length <= left) {
				this.chunks.shift();
				left -= c.length;
			} else {
				this.chunks[0] = c.subarray(left);
				left = 0;
			}
		}
		this.total -= n;
		return Buffer.concat(parts);
	}
}

/** Socket-type string carried in the READY metadata (ZMTP "Socket-Type"). */
export type ZmtpSocketType = "DEALER" | "SUB";

interface ReadReady {
	resolve(): void;
	reject(error: Error): void;
}

/** One ZMTP client connection: TCP socket + greeting/READY handshake → complete multipart messages. */
export class ZmtpSocket {
	private socket?: Socket;
	private parser = new ZmtpFrameParser();
	private readyResolve?: ReadReady;
	private closed = false;
	onMessage?: (frames: Buffer[]) => void;
	onClose?: () => void;

	private constructor(socket: Socket) {
		this.socket = socket;
	}

	/** Connect to `host:port` and complete the ZMTP handshake for `socketType`. */
	static connect(opts: { host: string; port: number; socketType: ZmtpSocketType }): Promise<ZmtpSocket> {
		const socket = connect({ host: opts.host, port: opts.port });
		const z = new ZmtpSocket(socket);
		// --- the peer's 64-byte greeting is not frame-formatted; collect it before the parser sees bytes ---
		let greeting = Buffer.alloc(0);

		socket.on("data", (chunk) => {
			if (greeting.length < GREETING_LENGTH) {
				const take = Math.min(chunk.length, GREETING_LENGTH - greeting.length);
				greeting = Buffer.concat([greeting, chunk.subarray(0, take)]);
				chunk = chunk.subarray(take);
				if (greeting.length === GREETING_LENGTH) {
					const sig = greeting.subarray(0, GREETING_SIGNATURE.length);
					if (!sig.equals(GREETING_SIGNATURE)) {
						z.failHandshake(
							new Error(`ZMTP peer at ${opts.host}:${opts.port} sent an unexpected signature (${sig.toString("hex")})`),
						);
						return;
					}
					// --- greeting done: announce our socket type, then await the peer's ---
					z.send([buildReadyMetadata(opts.socketType)]);
				}
			}
			if (greeting.length === GREETING_LENGTH) {
				for (const message of z.parser.feed(chunk)) {
					const ready = z.readyResolve;
					if (ready) {
						// --- the first frame after the greeting is the peer's READY ---
						z.readyResolve = undefined;
						ready.resolve();
						continue;
					}
					z.deliver(message);
				}
			}
		});
		socket.on("error", (error) => {
			if (z.readyResolve) {
				z.failHandshake(new Error(`ZMTP connection to ${opts.host}:${opts.port} failed: ${error.message}`));
			}
			// --- node always follows an error with 'close', which handles teardown ---
		});
		socket.on("close", () => {
			if (z.closed) return;
			z.closed = true;
			if (z.readyResolve) {
				z.failHandshake(new Error(`ZMTP connection to ${opts.host}:${opts.port} closed during handshake`));
				return;
			}
			z.onClose?.();
		});

		return new Promise<ZmtpSocket>((resolve, reject) => {
			z.readyResolve = { resolve: () => resolve(z), reject };
			socket.on("connect", () => {
				// --- full greeting in one write; the peer may split its reply ---
				socket.write(buildGreeting());
			});
		});
	}

	private failHandshake(error: Error): void {
		const ready = this.readyResolve;
		if (!ready) return;
		this.readyResolve = undefined;
		ready.reject(error);
		this.close();
	}

	private deliver(message: Buffer[]): void {
		this.onMessage?.(message);
	}

	/** Send a multipart message (DEALER) or a single subscription frame (SUB). */
	send(frames: Uint8Array[]): void {
		for (let i = 0; i < frames.length; i++) {
			this.socket?.write(encodeFrame(frames[i], i < frames.length - 1));
		}
	}

	/** SUB only: subscribe to a topic prefix (empty = all traffic). */
	subscribe(topic: Uint8Array): void {
		this.send([Buffer.concat([Buffer.from([0x01]), topic])]);
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

/** The READY metadata frame: `\x05READY` + Socket-Type + Identity properties. */
function buildReadyMetadata(socketType: ZmtpSocketType): Buffer {
	const type = Buffer.from(socketType);
	const body = Buffer.concat([
		Buffer.from("\x05READY"),
		Buffer.from("\x0bSocket-Type"),
		Buffer.from([0, 0, 0, type.length]),
		type,
		Buffer.from("\x08Identity"),
		Buffer.from([0, 0, 0, 0]), // empty identity: the routing id lives in ZMTP, not Jupyter
	]);
	return body;
}
