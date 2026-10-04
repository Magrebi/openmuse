import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffFor,
  cursorInView,
  decodeMirrorFrame,
  MirrorClient,
  type MirrorSnapshot,
  type MirrorSocketLike,
  toBase64,
} from "../src/mirror-client.ts";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

/** A frame as the server would encode it. */
function frame(sequence: number, x = 10, y = 20, jpeg = JPEG): Uint8Array {
  const out = new Uint8Array(9 + jpeg.length);
  out[0] = 0x01;
  out[1] = (sequence >>> 24) & 0xff;
  out[2] = (sequence >>> 16) & 0xff;
  out[3] = (sequence >>> 8) & 0xff;
  out[4] = sequence & 0xff;
  out[5] = (x >>> 8) & 0xff;
  out[6] = x & 0xff;
  out[7] = (y >>> 8) & 0xff;
  out[8] = y & 0xff;
  out.set(jpeg, 9);
  return out;
}

/** A socket whose lifecycle the test drives. */
function fakeSocket() {
  const record = {
    closed: [] as (string | undefined)[],
    sent: [] as string[],
    readyState: 1,
    binaryType: "",
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    send(data: string) {
      record.sent.push(data);
    },
    close(_code?: number, reason?: string) {
      record.closed.push(reason);
      record.readyState = 3;
    },
  };
  return record;
}

/** A client wired to fake sockets and a fake clock. */
function harness(options: { backoff?: number[] } = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const timers: { fn: () => void; delay: number; cleared: boolean }[] = [];
  const seen: MirrorSnapshot[] = [];
  const client = new MirrorClient("ws://mirror", {
    socket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket as unknown as MirrorSocketLike;
    },
    onChange: (snapshot) => seen.push(snapshot),
    setTimeoutFn: ((fn: () => void, delay: number) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((timer: unknown) => {
      (timer as { cleared: boolean }).cleared = true;
    }) as unknown as typeof clearTimeout,
    ...(options.backoff ? { backoff: options.backoff } : {}),
  });
  return {
    client,
    sockets,
    timers,
    seen,
    status: () => client.getSnapshot().status,
    runTimers: () => {
      const pending = timers.filter((t) => !t.cleared);
      timers.length = 0;
      for (const timer of pending) timer.fn();
    },
  };
}

test("a frame decodes to its bytes and cursor position", () => {
  const decoded = decodeMirrorFrame(frame(7, 640, 400));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.sequence, 7);
  assert.equal(decoded.x, 640);
  assert.equal(decoded.y, 400);
  assert.deepEqual([...decoded.bytes], [...JPEG]);
});

test("anything that is not a complete JPEG is rejected rather than rendered", () => {
  // An empty payload would otherwise publish a zero-byte image source, and the
  // view would show a broken image forever with no error.
  assert.deepEqual(decodeMirrorFrame("a string"), { ok: false, reason: "not-binary" });
  assert.deepEqual(decodeMirrorFrame(new Uint8Array(3)), { ok: false, reason: "too-short" });
  assert.deepEqual(decodeMirrorFrame(frame(1, 0, 0, new Uint8Array(0))), {
    ok: false,
    reason: "not-a-jpeg",
  });
  assert.deepEqual(decodeMirrorFrame(frame(1, 0, 0, Uint8Array.from([0x89, 0x50, 1]))), {
    ok: false,
    reason: "not-a-jpeg",
  });
  const wrongType = frame(1);
  wrongType[0] = 0x09;
  assert.deepEqual(decodeMirrorFrame(wrongType), { ok: false, reason: "unknown-type" });
});

test("the backoff grows and then stops growing", () => {
  assert.equal(backoffFor(0), 500);
  assert.equal(backoffFor(4), 10000);
  assert.equal(backoffFor(99), 10000, "an outage must not back off into never retrying");
  assert.equal(backoffFor(-3), 500);
  assert.equal(backoffFor(Number.NaN), 500);
});

test("a client connects once and reports live when the socket opens", () => {
  const h = harness();
  h.client.start();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.status(), "connecting");
  h.sockets[0].onopen?.();
  assert.equal(h.status(), "live");
  h.client.stop();
});

test("frames are published in order and dropped frames are counted", () => {
  const h = harness();
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: frame(1, 10, 20) });
  assert.equal(h.client.getSnapshot().frame?.x, 10);
  assert.equal(h.client.getSnapshot().dropped, 0);
  // 1 then 4: two frames never arrived.
  h.sockets[0].onmessage?.({ data: frame(4, 30, 40) });
  assert.equal(h.client.getSnapshot().frame?.x, 30);
  assert.equal(h.client.getSnapshot().dropped, 2);
  h.client.stop();
});

test("a wrapped sequence is not counted as a gap", () => {
  const h = harness();
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: frame(4294967295) });
  h.sockets[0].onmessage?.({ data: frame(0) });
  assert.equal(h.client.getSnapshot().dropped, 0, "4294967295 then 0 is contiguous");
  h.client.stop();
});

test("a dropped connection reconnects after the backoff, and resets it on success", () => {
  const h = harness({ backoff: [10, 20, 30] });
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onclose?.();
  assert.equal(h.status(), "reconnecting");
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 10);
  h.runTimers();
  assert.equal(h.sockets.length, 2, "a retry must actually open a new socket");
  h.sockets[1].onopen?.();
  // A successful open resets the schedule.
  h.sockets[1].onclose?.();
  assert.equal(h.timers.at(-1)?.delay, 10, "the backoff must reset after a good connection");
  h.client.stop();
});

test("repeated failures back off further without ever giving up", () => {
  const h = harness({ backoff: [5, 15, 45] });
  h.client.start();
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    h.sockets.at(-1)?.onclose?.();
    delays.push(h.timers.at(-1)?.delay ?? -1);
    h.runTimers();
  }
  assert.deepEqual(delays, [5, 15, 45, 45], "the schedule climbs then holds");
  h.client.stop();
});

test("closing the mirror stops it for good, without reopening", () => {
  // The bug this guards: a deliberate close that still schedules a reconnect
  // means closing the sheet immediately brings the mirror back.
  const h = harness({ backoff: [10] });
  h.client.start();
  h.sockets[0].onopen?.();
  h.client.stop();
  assert.equal(h.status(), "ended");
  assert.equal(h.timers.length, 0, "stopping must not schedule a retry");
  assert.deepEqual(h.sockets[0].closed, ["Mirror closed"]);
  // Detached before closing, so the socket's own close cannot schedule a retry.
  assert.equal(h.sockets[0].onclose, null, "handlers must be detached");
  h.runTimers();
  assert.equal(h.sockets.length, 1, "no new socket may be opened");
});

test("stopping twice is harmless and does not double-close", () => {
  const h = harness();
  h.client.start();
  h.client.stop();
  h.client.stop();
  assert.deepEqual(h.sockets[0].closed, ["Mirror closed"]);
});

test("starting twice does not open two sockets", () => {
  const h = harness();
  h.client.start();
  h.client.start();
  assert.equal(h.sockets.length, 1);
  h.client.stop();
});

test("a pending retry is cancelled when the mirror is closed", () => {
  const h = harness({ backoff: [10] });
  h.client.start();
  h.sockets[0].onclose?.();
  assert.equal(h.timers.length, 1);
  h.client.stop();
  assert.equal(h.timers[0].cleared, true, "the pending retry must not outlive the mirror");
});

test("a socket that cannot even be created is retried rather than fatal", () => {
  let attempts = 0;
  const timers: { fn: () => void; delay: number }[] = [];
  const client = new MirrorClient("ws://mirror", {
    socket: () => {
      attempts++;
      if (attempts === 1) throw new Error("no network");
      return fakeSocket() as unknown as MirrorSocketLike;
    },
    setTimeoutFn: ((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    backoff: [7],
  });
  client.start();
  assert.equal(attempts, 1);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(attempts, 2, "a failed construction must be retried");
  client.stop();
});

test("a status message updates the page without disturbing the frame", () => {
  const h = harness();
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: frame(1, 5, 6) });
  h.sockets[0].onmessage?.({
    data: JSON.stringify({ type: "status", url: "https://example.com", title: "Example" }),
  });
  const snapshot = h.client.getSnapshot();
  assert.equal(snapshot.url, "https://example.com");
  assert.equal(snapshot.title, "Example");
  assert.equal(snapshot.frame?.x, 5, "the current frame must survive a status update");
  h.client.stop();
});

test("malformed control text is ignored rather than throwing", () => {
  const h = harness();
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: "not json" });
  h.sockets[0].onmessage?.({ data: '{"type":"unknown-kind"}' });
  assert.equal(h.client.getSnapshot().status, "live");
  h.client.stop();
});

test("the server saying the session ended is terminal, not a retry", () => {
  const h = harness({ backoff: [10] });
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: JSON.stringify({ type: "ended" }) });
  assert.equal(h.status(), "ended");
  assert.equal(h.timers.length, 0, "a gone session must not be retried against");
  h.client.stop();
});

test("an ArrayBuffer message is decoded like a typed array", () => {
  // React Native's WebSocket can deliver either depending on platform.
  const h = harness();
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: frame(1, 77, 88).buffer as ArrayBuffer });
  assert.equal(h.client.getSnapshot().frame?.x, 77);
  assert.equal(h.sockets[0].binaryType, "arraybuffer");
  h.client.stop();
});

test("every state change is published, so a view cannot miss one", () => {
  const h = harness({ backoff: [5] });
  h.client.start();
  h.sockets[0].onopen?.();
  h.sockets[0].onmessage?.({ data: frame(1) });
  h.sockets[0].onclose?.();
  h.runTimers();
  h.sockets[1].onopen?.();
  h.client.stop();
  assert.ok(h.seen.length >= 5);
  assert.ok(
    h.seen.some((s) => s.status === "live"),
    "the view must have been told it went live",
  );
  assert.equal(h.seen.at(-1)?.status, "ended");
});

test("base64 matches btoa on every remainder length", () => {
  // All three group remainders, because the padding cases are where a
  // hand-written encoder usually goes wrong.
  for (let length = 1; length <= 16; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(toBase64(bytes), expected, `length ${length}`);
  }
  assert.equal(toBase64(new Uint8Array(0)), "");
});

test("base64 handles a frame far larger than the argument limit", () => {
  // `String.fromCharCode(...bytes)` throws above a few tens of kilobytes, and
  // every real JPEG frame is larger than that.
  const bytes = new Uint8Array(300_000).fill(0xab);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("the cursor lands on the page inside the view, letterboxing included", () => {
  // A view of exactly the page's aspect ratio has no offsets at all.
  assert.deepEqual(cursorInView(0, 0, { width: 1280, height: 800 }), { x: 0, y: 0 });
  assert.deepEqual(cursorInView(1280, 800, { width: 1280, height: 800 }), { x: 1280, y: 800 });
  // Half scale puts the far corner at 640x400.
  assert.deepEqual(cursorInView(1280, 800, { width: 640, height: 400 }), { x: 640, y: 400 });
});

test("a taller-than-wide view centres the frame rather than stretching it", () => {
  // The bug this guards: scaling by width alone would put the cursor below the
  // bottom of the frame on any tall view.
  const view = { width: 1280, height: 1200 };
  const scale = 1280 / 1280;
  const placed = cursorInView(640, 800, view);
  assert.equal(placed.x, 640, "horizontally the page fills the view");
  assert.equal(placed.y, (1200 - 800 * scale) / 2 + 800 * scale, "vertically it is centred");
  assert.ok(placed.y <= view.height, "and stays inside the view");
});

test("a degenerate view puts the cursor at the origin rather than at NaN", () => {
  for (const view of [
    { width: 0, height: 0 },
    { width: Number.NaN, height: 100 },
    { width: -10, height: 100 },
  ]) {
    const placed = cursorInView(640, 400, view);
    assert.ok(Number.isFinite(placed.x) && Number.isFinite(placed.y), JSON.stringify(view));
  }
  assert.deepEqual(cursorInView(640, 400, { width: 0, height: 0 }), { x: 0, y: 0 });
});

test("a non-finite cursor coordinate cannot move the marker off the page", () => {
  const placed = cursorInView(Number.NaN, Number.POSITIVE_INFINITY, { width: 1280, height: 800 });
  assert.deepEqual(placed, { x: 0, y: 0 });
});
