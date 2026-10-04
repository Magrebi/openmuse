import { backgroundFailure } from "./log.ts";
import {
  controlMessage,
  encodeFrame,
  isRenderableJpeg,
  MAX_FRAME_BYTES,
  MAX_MIRROR_VIEWERS,
  MIN_CAPTURE_INTERVAL_MS,
  type MirrorCursor,
} from "./mirror-protocol.ts";

/**
 * The part of a WebSocket this hub uses.
 *
 * Declared here rather than importing `ws` so the whole fan-out — its limits,
 * its back-pressure, and above all its teardown — can be tested against a
 * three-line fake with no network, no browser and no timers.
 */
export interface MirrorSocket {
  send(data: string | Uint8Array): void;
  /** Bytes queued and not yet written. Used to detect a client that cannot keep up. */
  readonly bufferedAmount?: number;
  close(code?: number, reason?: string): void;
}

/** One capture, as the worker's frame endpoint reports it. */
export interface MirrorCapture {
  jpeg: Uint8Array;
  cursor: MirrorCursor;
  url?: string;
  title?: string;
}

/**
 * Capture one frame.
 *
 * The owner is passed explicitly rather than captured, because every capture is
 * an authorization check: a mirror stream must never be able to read a browser
 * session on the strength of a stream key alone.
 */
export type MirrorCaptureFn = (
  owner: string,
  sessionId: string,
  signal: AbortSignal,
) => Promise<MirrorCapture>;

interface Viewer {
  readonly socket: MirrorSocket;
  /** Frames skipped for this viewer because it stopped draining its socket. */
  dropped: number;
}

/** One session being watched. Keyed by owner and id, never by id alone. */
interface Stream {
  readonly owner: string;
  readonly sessionId: string;
  readonly viewers: Set<Viewer>;
  timer?: ReturnType<typeof setInterval>;
  controller?: AbortController;
  sequence: number;
  lastCursor: MirrorCursor;
  /** Guards against a capture that outlives its interval. */
  capturing: boolean;
  closed: boolean;
}

/**
 * How much of a viewer's buffer may fill before frames are skipped for it.
 *
 * A viewer on a slow link that queues every frame will grow its socket buffer
 * without bound and take the process with it. Dropping frames instead keeps
 * memory flat and costs only the viewer that cannot keep up — the right trade
 * for a "watch what the agent is doing" stream, since the next frame is a
 * complete picture anyway.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * A stream's key.
 *
 * Scoped by owner so that two owners can never be counted against the same
 * viewer's budget, and so a capture can never be authorized on the key alone —
 * the owner travels with the stream, not just with the lookup.
 */
const streamKey = (owner: string, sessionId: string) => `${owner}\u0000${sessionId}`;

export class MirrorHub {
  private readonly streams = new Map<string, Stream>();
  private closed = false;

  constructor(
    private readonly capture: MirrorCaptureFn,
    private readonly options: {
      intervalMs?: number;
      maxViewers?: number;
      now?: () => number;
      setInterval?: typeof setInterval;
      clearInterval?: typeof clearInterval;
    } = {},
  ) {}

  private get intervalMs() {
    return Math.max(MIN_CAPTURE_INTERVAL_MS, this.options.intervalMs ?? MIN_CAPTURE_INTERVAL_MS);
  }
  private get maxViewers() {
    return this.options.maxViewers ?? MAX_MIRROR_VIEWERS;
  }

  /** How many sessions are currently being captured. Used by tests and shutdown. */
  get activeStreams() {
    return this.streams.size;
  }

  /** Total viewers across all sessions. */
  get viewerCount() {
    let total = 0;
    for (const stream of this.streams.values()) total += stream.viewers.size;
    return total;
  }

  /**
   * Attach a socket to a session's mirror.
   *
   * Returns false when the session is already full, which the route turns into
   * a refusal rather than silently dropping the connection — a person who asked
   * to watch and got a socket that never produces a frame cannot tell that
   * apart from a broken feature.
   */
  watch(owner: string, sessionId: string, socket: MirrorSocket): boolean {
    if (this.closed) return false;
    const key = streamKey(owner, sessionId);
    let stream = this.streams.get(key);
    if (!stream) {
      stream = {
        owner,
        sessionId,
        viewers: new Set(),
        sequence: 0,
        lastCursor: { x: 0, y: 0 },
        capturing: false,
        closed: false,
      };
      this.streams.set(key, stream);
    }
    if (stream.viewers.size >= this.maxViewers) return false;
    const viewer: Viewer = { socket, dropped: 0 };
    stream.viewers.add(viewer);
    // A client that connects mid-stream must learn the geometry before it can
    // size its surface, and should not wait a whole interval for the first shot.
    this.send(
      stream,
      socket,
      controlMessage("hello", {
        sessionId,
        width: 1280,
        height: 800,
        intervalMs: this.intervalMs,
      }),
    );
    this.start(stream);
    return true;
  }

  /** Detach a socket. The capture loop stops when the last viewer leaves. */
  unwatch(owner: string, sessionId: string, socket: MirrorSocket): void {
    const stream = this.streams.get(streamKey(owner, sessionId));
    if (!stream) return;
    for (const viewer of [...stream.viewers])
      if (viewer.socket === socket) stream.viewers.delete(viewer);
    // The departing viewer is closed explicitly rather than by the teardown
    // sweep, because teardown only ever sees the viewers still subscribed —
    // and a socket nobody closes stays half-open until the OS notices.
    if (stream.viewers.size === 0) this.teardown(stream, [socket]);
    else this.retire(socket);
  }

  /** Say goodbye to one socket and close it. */
  private retire(socket: MirrorSocket) {
    try {
      socket.send(controlMessage("ended"));
      socket.close(1000, "Mirror closed");
    } catch {
      backgroundFailure("close mirror viewer", new Error("socket already closed"));
    }
  }

  /**
   * Stop a stream and release everything it holds.
   *
   * `departing` names the sockets that are already unsubscribed but still need
   * closing; the sweep only ever sees viewers still in the set. Passing them
   * in is what stops a viewer who leaves voluntarily from being left
   * half-open.
   *
   * The order matters. The capture is aborted *before* anyone is closed, so an
   * in-flight screenshot cannot resolve into a socket that is already gone, and
   * `closed` makes a second call — which a close-during-teardown race produces —
   * a no-op rather than a double close of the same socket.
   */
  private teardown(stream: Stream, departing: MirrorSocket[] = []) {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.timer) {
      (this.options.clearInterval ?? clearInterval)(stream.timer);
      stream.timer = undefined;
    }
    stream.controller?.abort();
    stream.controller = undefined;
    const remaining = [...stream.viewers];
    stream.viewers.clear();
    for (const viewer of remaining) this.retire(viewer.socket);
    for (const socket of departing) this.retire(socket);
    this.streams.delete(streamKey(stream.owner, stream.sessionId));
  }

  private async tick(stream: Stream) {
    if (stream.closed || stream.viewers.size === 0) return this.teardown(stream);
    // One capture at a time: an overlapping pair would queue against the same
    // browser session and starve the agent's own work, which is the one thing
    // the mirror must never slow down.
    if (stream.capturing) return;
    stream.capturing = true;
    const controller = new AbortController();
    stream.controller = controller;
    try {
      const result = await this.capture(stream.owner, stream.sessionId, controller.signal);
      if (stream.closed || controller.signal.aborted) return;
      // A partial or oversized capture is dropped. Forwarding a truncated one
      // would render a torn image, and forwarding an oversized one is exactly
      // the unbounded buffer this hub exists to prevent.
      if (
        !result ||
        result.jpeg.length === 0 ||
        result.jpeg.length > MAX_FRAME_BYTES ||
        !isRenderableJpeg(result.jpeg)
      )
        return;
      stream.sequence = (stream.sequence + 1) >>> 0;
      stream.lastCursor = result.cursor;
      this.broadcast(stream, encodeFrame(result.jpeg, result.cursor, stream.sequence), result);
    } catch (error) {
      if (!controller.signal.aborted && !stream.closed)
        this.broadcastText(stream, controlMessage("status", { state: "unavailable" }));
      if (!controller.signal.aborted) backgroundFailure("mirror capture", error);
    } finally {
      stream.capturing = false;
      if (stream.controller === controller) stream.controller = undefined;
    }
  }

  private broadcast(stream: Stream, payload: Uint8Array, capture: MirrorCapture) {
    for (const viewer of [...stream.viewers])
      if (!this.send(stream, viewer.socket, payload)) viewer.dropped++;
    // Status follows the frames rather than preceding them, so a client never
    // sees a title before the picture that title belongs to.
    if (capture.url || capture.title)
      this.broadcastText(
        stream,
        controlMessage("status", { url: capture.url ?? "", title: capture.title ?? "" }),
      );
  }

  private broadcastText(stream: Stream, text: string) {
    for (const viewer of [...stream.viewers]) this.send(stream, viewer.socket, text);
  }

  private send(stream: Stream, socket: MirrorSocket, payload: string | Uint8Array): boolean {
    if (stream.viewers.size === 0) return false;
    const buffered = socket.bufferedAmount ?? 0;
    // Only binary frames are skipped: a control message is tiny, and losing one
    // would leave a client without a geometry or an end signal.
    if (typeof payload !== "string" && buffered > MAX_BUFFERED_BYTES) return false;
    try {
      socket.send(payload);
      return true;
    } catch {
      // A socket that threw is gone. Removing it here is what keeps a client
      // that vanished without a close frame from pinning a session's capture
      // loop open for the rest of the process's life.
      for (const viewer of [...stream.viewers])
        if (viewer.socket === socket) stream.viewers.delete(viewer);
      if (stream.viewers.size === 0) this.teardown(stream);
      return false;
    }
  }

  /** Stop every capture and close every socket. Called on shutdown. */
  async close() {
    this.closed = true;
    for (const stream of [...this.streams.values()]) this.teardown(stream);
    this.streams.clear();
  }

  private start(stream: Stream) {
    if (stream.timer || stream.closed) return;
    const schedule = this.options.setInterval ?? setInterval;
    stream.timer = schedule(() => void this.tick(stream), this.intervalMs);
    // Never hold the process open for a viewer.
    (stream.timer as { unref?: () => void }).unref?.();
  }
}
