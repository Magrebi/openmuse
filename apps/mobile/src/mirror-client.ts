/**
 * The live browser mirror, client side.
 *
 * A `WebSocket` that reconnects with backoff, decodes the frame protocol, and
 * publishes the latest frame to React. All the decision-making is here rather
 * than in the view, because the decision-making is where the bugs live:
 *
 * - A frame that arrives out of order, or after the socket closed, must not be
 *   rendered. Rendering one would leave the mirror showing a page that was
 *   never on screen at that moment.
 * - A dropped connection has to retry, or a phone that sleeps for ten seconds
 *   would never show the agent again.
 * - Every timer and listener has to be released, or repeatedly opening and
 *   closing the mirror would accumulate them for the life of the app.
 *
 * No React import, so all of it is testable under plain Node.
 */

/** A frame the mirror has decoded and is ready to draw. */
export interface MirrorFrame {
  /** The JPEG bytes. */
  readonly bytes: Uint8Array;
  /** Where the agent's pointer last was, in mirror coordinates. */
  readonly x: number;
  readonly y: number;
  /** Frame sequence, so a gap is detectable. */
  readonly sequence: number;
}

export type MirrorStatus = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "error";

/** Everything the mirror publishes. */
export interface MirrorSnapshot {
  readonly status: MirrorStatus;
  readonly frame?: MirrorFrame;
  /** Page the agent is on, when the server has told us. */
  readonly url?: string;
  readonly title?: string;
  /** Frames received since the last gap, for the diagnostics row. */
  readonly dropped: number;
}

/** The slice of `WebSocket` this client uses, so it can be faked in tests. */
export interface MirrorSocketLike {
  binaryType?: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => MirrorSocketLike;

/** Reconnect backoff, in milliseconds, capped so a long outage still retries. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

/** Bytes before the JPEG payload. Mirrors `mirror-protocol.ts` on the server. */
export const HEADER_BYTES = 9;

/** The one frame type this client understands. */
const FRAME_TYPE = 0x01;

export interface MirrorClientOptions {
  /** Builds the socket. Injected so tests can drive reconnection without a server. */
  readonly socket: SocketFactory;
  /** Called on every state change. */
  readonly onChange?: (snapshot: MirrorSnapshot) => void;
  /** Injected for deterministic backoff in tests. */
  readonly now?: () => number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** Overridable so a test can exercise the backoff schedule without waiting. */
  readonly backoff?: readonly number[];
}

/** A decoded frame, or why one was rejected. */
export type FrameDecode =
  | { ok: true; sequence: number; x: number; y: number; bytes: Uint8Array }
  | { ok: false; reason: "not-binary" | "too-short" | "unknown-type" | "not-a-jpeg" };

/**
 * Decode one binary message.
 *
 * Pure, and mirrors the server's codec exactly — a client that disagreed about
 * the header length would render the first 9 bytes of every JPEG as picture
 * data, which looks like a corrupted image rather than a protocol mismatch.
 */
export const decodeMirrorFrame = (data: unknown): FrameDecode => {
  if (!(data instanceof Uint8Array)) return { ok: false, reason: "not-binary" };
  if (data.length < HEADER_BYTES) return { ok: false, reason: "too-short" };
  if (data[0] !== FRAME_TYPE) return { ok: false, reason: "unknown-type" };
  const sequence = ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;
  const x = (data[5] << 8) | data[6];
  const y = (data[7] << 8) | data[8];
  const bytes = data.subarray(HEADER_BYTES);
  // A JPEG always starts SOI. Without this an empty payload would be published
  // and the image view would render a zero-byte source forever.
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return { ok: false, reason: "not-a-jpeg" };
  return { ok: true, sequence, x, y, bytes };
};

/** The delay before retry number `attempt` (0-based). */
export const backoffFor = (attempt: number, schedule: readonly number[] = BACKOFF_MS): number => {
  if (!Number.isFinite(attempt) || attempt < 0) return schedule[0];
  return schedule[Math.min(Math.floor(attempt), schedule.length - 1)];
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64-encode image bytes, without pulling in a dependency for it.
 *
 * Written out rather than delegating to `btoa` because React Native has no
 * `btoa`, and `String.fromCharCode(...bytes)` overflows the argument limit on
 * anything over a few tens of kilobytes — which every real frame exceeds. The
 * chunked spread below is what keeps that from throwing on a full-size frame.
 */
export const toBase64 = (bytes: Uint8Array): string => {
  if (!bytes.length) return "";
  const btoaImpl = (globalThis as { btoa?: (input: string) => string }).btoa;
  if (typeof btoaImpl === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoaImpl(binary);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    // A missing final group is padded, exactly as the encoding requires.
    out += b === undefined ? "=" : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 63];
  }
  return out;
};

/** The page coordinate space the mirror reports in. */
export const MIRROR_VIEW = { width: 1280, height: 800 } as const;

/**
 * Where a page coordinate lands inside a view of a given size.
 *
 * The server reports the cursor in the page's own 1280x800 space, and the frame
 * is drawn `contain`-fit inside the view, so the scale is the smaller of the two
 * ratios. Using only the width ratio — the obvious simplification — puts the
 * cursor below the frame whenever the view is proportionally taller, which is
 * most phone screens.
 */
export const cursorInView = (
  x: number,
  y: number,
  view: { width: number; height: number },
): { x: number; y: number } => {
  const scale = Math.min(view.width / MIRROR_VIEW.width, view.height / MIRROR_VIEW.height);
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0 };
  const drawnWidth = MIRROR_VIEW.width * scale;
  const drawnHeight = MIRROR_VIEW.height * scale;
  // Letterbox offsets: the frame is centred, so the cursor has to be too.
  const offsetX = (view.width - drawnWidth) / 2;
  const offsetY = (view.height - drawnHeight) / 2;
  return {
    x: offsetX + (Number.isFinite(x) ? x : 0) * scale,
    y: offsetY + (Number.isFinite(y) ? y : 0) * scale,
  };
};

/**
 * A mirror connection.
 *
 * Not a React hook on purpose: the React wrapper is three lines, and keeping
 * the socket lifecycle in a plain class means the reconnection, the ordering
 * checks and the timer cleanup are all testable without a renderer.
 */
export class MirrorClient {
  private socket?: MirrorSocketLike;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private started = false;
  private lastSequence?: number;
  private current: MirrorSnapshot = { status: "idle", dropped: 0 };

  constructor(
    private readonly url: string,
    private readonly options: MirrorClientOptions,
  ) {}

  getSnapshot = () => this.current;

  private publish(patch: Partial<MirrorSnapshot>) {
    this.current = { ...this.current, ...patch };
    this.options.onChange?.(this.current);
  }

  /** Open the socket, or do nothing if it is already open or opening. */
  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /**
   * Close and stay closed.
   *
   * `started` is what distinguishes "closed on purpose" from "dropped", because
   * only the second should be retried — without that distinction, closing the
   * mirror sheet would immediately reopen it.
   */
  stop() {
    this.started = false;
    if (this.timer) {
      (this.options.clearTimeoutFn ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    // Detach the handlers first: the close handler would otherwise schedule a
    // reconnect for a socket this method is deliberately shutting down.
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close(1000, "Mirror closed");
      } catch {
        /* Already gone; nothing to release. */
      }
    }
    this.publish({ status: "ended" });
  }

  private connect() {
    if (!this.started) return;
    this.publish({ status: this.attempt === 0 ? "connecting" : "reconnecting" });
    let socket: MirrorSocketLike;
    try {
      socket = this.options.socket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // Binary frames arrive as ArrayBuffer on the web; asking for it explicitly
    // means one decode path rather than one per platform.
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      // A successful open resets the backoff, so a connection that flaps once an
      // hour does not end up waiting ten seconds after each blip.
      this.attempt = 0;
      this.publish({ status: "live" });
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      /* The close handler follows and owns the retry; all this has to do is
         stop the error event being unhandled. */
    };
    socket.onclose = () => {
      // Only the socket we are currently on may schedule a retry. Without this
      // a socket replaced by a reconnect could close later and queue another.
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.scheduleReconnect();
    };
  }

  private receive(data: unknown) {
    if (typeof data === "string") {
      let parsed: { type?: string; url?: string; title?: string } | null = null;
      try {
        parsed = JSON.parse(data) as { type?: string };
      } catch {
        return;
      }
      const type = parsed?.type;
      if (type === "status") this.publish({ url: parsed?.url, title: parsed?.title });
      // `ended` is the server saying the session is gone. Retrying would spin
      // against a session that is never coming back, so it is terminal.
      else if (type === "ended") this.stop();
      return;
    }
    const decoded = decodeMirrorFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (!decoded.ok) return;
    // A frame whose sequence is not the successor came from a stream that
    // restarted or reordered. Rendering it would show a moment that never was.
    if (this.lastSequence !== undefined) {
      const gap = (decoded.sequence - this.lastSequence) >>> 0;
      if (gap !== 1 && gap < 0x7fffffff) this.publish({ dropped: this.current.dropped + gap - 1 });
    }
    this.lastSequence = decoded.sequence;
    this.publish({
      status: "live",
      frame: { bytes: decoded.bytes, x: decoded.x, y: decoded.y, sequence: decoded.sequence },
    });
  }

  private scheduleReconnect() {
    if (!this.started || this.timer) return;
    const delay = backoffFor(this.attempt, this.options.backoff);
    this.attempt++;
    this.publish({ status: "reconnecting" });
    this.timer = (this.options.setTimeoutFn ?? setTimeout)(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }
}
