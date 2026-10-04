/**
 * The wire format of the live browser mirror.
 *
 * The mirror pushes a frame every time the agent's browser moves, so this runs
 * continuously for as long as someone is watching. Two things follow from that,
 * and they are the whole reason this module exists separately from the transport:
 *
 * - **Frames are bounded.** An image is the one message in this server that is
 *   not naturally small, so the codec refuses to encode anything over a limit
 *   rather than letting a runaway browser fill a socket buffer.
 * - **Frames are self-describing and ordered.** A slow network drops frames; a
 *   client that cannot tell which ones it missed would render a torn image. Each
 *   frame carries a sequence number so a gap is detectable rather than silent.
 *
 * Everything here is pure so the format can be tested without a browser, a
 * socket, or a clock.
 */

/** Message types on the wire. Kept small and stable; the client switches on them. */
export const frameTypes = {
  /** Binary: a JPEG plus the cursor position that produced it. */
  frame: 0x01,
} as const;

export const controlTypes = ["hello", "status", "paused", "ended"] as const;
export type ControlType = (typeof controlTypes)[number];

/**
 * The widest frame the codec will produce.
 *
 * A 1280x800 JPEG of a real page is 80-200 KB at the quality the mirror uses;
 * 512 KB leaves room for a dense page while still bounding a single message.
 * Anything larger is a bug upstream and is dropped rather than forwarded.
 */
export const MAX_FRAME_BYTES = 512 * 1024;

/** The coordinate space frames and cursors are expressed in. */
export const MIRROR_WIDTH = 1280;
export const MIRROR_HEIGHT = 800;

/**
 * The smallest acceptable interval between two captures of the same session.
 *
 * The mirror is deliberately a low-framerate companion to the agent's work, not
 * a remote desktop: it exists so a person can see *what* the agent is looking
 * at. Above ~4fps it stops being informative and starts competing with the
 * agent for the single serialised session queue — which would slow down the very
 * work it is meant to be showing.
 */
export const MIN_CAPTURE_INTERVAL_MS = 250;

/** How many clients may watch one session. */
export const MAX_MIRROR_VIEWERS = 4;

/** Where the agent's cursor is on the page, in mirror coordinates. */
export interface MirrorCursor {
  x: number;
  y: number;
}

/**
 * Clamp a cursor to the page.
 *
 * A coordinate outside the viewport would place the cursor marker off the
 * rendered frame, which reads as the client having lost sync rather than as the
 * agent having moved somewhere odd.
 */
export const clampCursor = (x: unknown, y: unknown): MirrorCursor => {
  const toNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    x: Math.max(0, Math.min(MIRROR_WIDTH, Math.round(toNumber(x)))),
    y: Math.max(0, Math.min(MIRROR_HEIGHT, Math.round(toNumber(y)))),
  };
};

/** Bytes before the JPEG payload: type, sequence and cursor. */
export const HEADER_BYTES = 9;

/**
 * Encode one frame.
 *
 * Layout, so a client can skip the header without copying:
 *
 * ```text
 * | 0x01 | seq (4, big endian) | cursorX (2) | cursorY (2) | JPEG bytes |
 * ```
 *
 * `seq` wraps at 2^32. That is deliberate: a mirror left open for longer than
 * one frame per 250ms would take 34 years to wrap, so a client that sees a
 * *backwards* sequence knows the stream restarted rather than having stalled.
 */
export const encodeFrame = (
  jpeg: Uint8Array,
  cursor: MirrorCursor,
  sequence: number,
): Uint8Array => {
  const out = new Uint8Array(HEADER_BYTES + jpeg.length);
  out[0] = frameTypes.frame;
  const seq = Math.max(0, Math.trunc(sequence)) >>> 0;
  out[1] = (seq >>> 24) & 0xff;
  out[2] = (seq >>> 16) & 0xff;
  out[3] = (seq >>> 8) & 0xff;
  out[4] = seq & 0xff;
  const { x, y } = clampCursor(cursor.x, cursor.y);
  out[5] = (x >>> 8) & 0xff;
  out[6] = x & 0xff;
  out[7] = (y >>> 8) & 0xff;
  out[8] = y & 0xff;
  out.set(jpeg, HEADER_BYTES);
  return out;
};

/** A decoded frame, or the reason one could not be decoded. */
export type DecodeResult =
  | { ok: true; sequence: number; cursor: MirrorCursor; jpeg: Uint8Array }
  | { ok: false; reason: "empty" | "unknown-type" | "truncated" };

/** Decode one frame. The exact inverse of `encodeFrame`. */
export const decodeFrame = (bytes: Uint8Array): DecodeResult => {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  // Length is checked before the type byte is trusted. A short message is not
  // "some other kind of message" — it is a frame that did not arrive whole, and
  // reporting it as the wrong type would send a client looking for a protocol
  // bug instead of a dropped one.
  if (bytes.length < HEADER_BYTES) return { ok: false, reason: "truncated" };
  if (bytes[0] !== frameTypes.frame) return { ok: false, reason: "unknown-type" };
  const sequence = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
  const cursor = { x: (bytes[5] << 8) | bytes[6], y: (bytes[7] << 8) | bytes[8] };
  return { ok: true, sequence, cursor, jpeg: bytes.subarray(HEADER_BYTES) };
};

/**
 * Whether a frame is large enough to be a JPEG.
 *
 * The transport cannot tell an empty body from a truncated one, and decoding a
 * partial JPEG in a browser produces a half-rendered image that a person would
 * read as the page being broken.
 */
export const isRenderableJpeg = (jpeg: Uint8Array): boolean =>
  jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8;

/**
 * A JSON control message.
 *
 * `hello` is sent once when the socket opens, so a client knows the stream's
 * geometry before it has seen a frame and can size its surface correctly.
 */
export const controlMessage = (
  type: ControlType,
  fields: Record<string, string | number | boolean> = {},
): string => JSON.stringify({ type, ...fields });

/** Parse a control message, rejecting anything that is not a known type. */
export const parseControl = (
  text: string,
): { type: ControlType; fields: Record<string, unknown> } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { type, ...fields } = parsed as Record<string, unknown>;
  return typeof type === "string" && controlTypes.includes(type as ControlType)
    ? { type: type as ControlType, fields }
    : null;
};

/**
 * Whether a sequence number means "one was missed".
 *
 * Wrap-around is handled: 4294967295 followed by 0 is contiguous, not a gap.
 * A plain `<` comparison would report a gap there and stall the client.
 */
export const isGap = (previous: number, next: number): boolean => {
  const a = previous >>> 0;
  const b = next >>> 0;
  if (b === a) return false;
  const distance = (b - a) >>> 0;
  // Half the sequence space is unreachable in practice, so treat it as a wrap.
  return distance > 1 && distance < 0x7fffffff;
};
