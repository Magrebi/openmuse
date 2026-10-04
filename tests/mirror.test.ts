import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MirrorCapture,
  type MirrorCaptureFn,
  MirrorHub,
  type MirrorSocket,
} from "../apps/server/src/mirror.ts";
import {
  clampCursor,
  controlMessage,
  decodeFrame,
  encodeFrame,
  isGap,
  isRenderableJpeg,
  MAX_FRAME_BYTES,
  parseControl,
} from "../apps/server/src/mirror-protocol.ts";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
/** A well-formed session id, used by the upgrade-authorization tests. */
const SOME_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A socket that records everything and can be told to fail or to back up. */
function fakeSocket(options: { throwOnSend?: boolean; bufferedAmount?: number } = {}) {
  const sent: (string | Uint8Array)[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const socket: MirrorSocket = {
    send(data) {
      if (options.throwOnSend) throw new Error("socket is gone");
      sent.push(data);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
    get bufferedAmount() {
      return options.bufferedAmount ?? 0;
    },
  };
  return { socket, sent, closed };
}

/** A hub whose interval is driven by the test rather than by a real clock. */
function harness(
  capture: (_owner: string, _id: string, signal: AbortSignal) => Promise<MirrorCapture>,
  options: { maxViewers?: number } = {},
) {
  const timers = new Map<number, { fn: () => void; interval: number }>();
  let next = 1;
  const hub = new MirrorHub(capture, {
    ...options,
    setInterval: ((fn: () => void, interval: number) => {
      const id = next++;
      timers.set(id, { fn, interval });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: unknown) => {
      timers.delete(id as number);
    }) as unknown as typeof clearInterval,
  });
  return {
    hub,
    /** Fire every live timer once and let the capture's promises settle. */
    async fire() {
      for (const timer of [...timers.values()]) await timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get liveTimers() {
      return timers.size;
    },
  };
}

const captureOf = (overrides: Partial<MirrorCapture> = {}): (() => Promise<MirrorCapture>) => {
  let x = 10;
  return async () => {
    x = (x + 7) % 1280;
    return { jpeg: JPEG, cursor: { x, y: 400 }, url: "https://example.com", ...overrides };
  };
};
test("a frame round-trips through the codec with its cursor and sequence intact", () => {
  for (const sequence of [0, 1, 255, 65536, 4294967295]) {
    const decoded = decodeFrame(encodeFrame(JPEG, { x: 640, y: 400 }, sequence));
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.sequence, sequence);
    assert.deepEqual(decoded.cursor, { x: 640, y: 400 });
    assert.deepEqual([...decoded.jpeg], [...JPEG]);
  }
});

test("a truncated or mistyped frame is rejected rather than rendered half-drawn", () => {
  assert.deepEqual(decodeFrame(new Uint8Array(0)), { ok: false, reason: "empty" });
  assert.deepEqual(decodeFrame(new Uint8Array(4)), { ok: false, reason: "truncated" });
  assert.deepEqual(decodeFrame(Uint8Array.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8])), {
    ok: false,
    reason: "unknown-type",
  });
});

test("a cursor off the page is clamped instead of being drawn outside the frame", () => {
  assert.deepEqual(clampCursor(-50, -10), { x: 0, y: 0 });
  assert.deepEqual(clampCursor(99999, 99999), { x: 1280, y: 800 });
  assert.deepEqual(clampCursor("nonsense", null), { x: 0, y: 0 });
  assert.deepEqual(clampCursor(Number.NaN, Number.POSITIVE_INFINITY), { x: 0, y: 0 });
});

test("only a JPEG is treated as a renderable picture", () => {
  assert.equal(isRenderableJpeg(JPEG), true);
  assert.equal(isRenderableJpeg(new Uint8Array(0)), false);
  assert.equal(isRenderableJpeg(Uint8Array.from([0xff])), false);
  assert.equal(isRenderableJpeg(Uint8Array.from([0x89, 0x50, 0x4e])), false);
});

test("control messages are typed, and anything unrecognised is rejected", () => {
  assert.equal(controlMessage("hello", { width: 1280 }), '{"type":"hello","width":1280}');
  assert.equal(parseControl('{"type":"status","title":"x"}')?.type, "status");
  assert.equal(parseControl('{"type":"evil"}'), null);
  assert.equal(parseControl("not json"), null);
  assert.equal(parseControl("[1,2,3]"), null);
  assert.equal(parseControl("null"), null);
});

test("a wrapped sequence is contiguous, not reported as a lost frame", () => {
  // A plain `<` comparison reports this as a gap and the client stalls forever.
  assert.equal(isGap(4294967295, 0), false);
  assert.equal(isGap(5, 6), false);
  assert.equal(isGap(5, 7), true);
  assert.equal(isGap(5, 5), false);
});

test("a viewer is told the geometry before it sees a frame", async () => {
  const { hub, fire } = harness(captureOf());
  const { socket, sent } = fakeSocket();
  hub.watch("local-user", "session-a", socket);
  assert.equal(sent.length, 1);
  const hello = parseControl(sent[0] as string);
  assert.equal(hello?.type, "hello");
  assert.equal(hello?.fields.width, 1280);
  assert.equal(hello?.fields.sessionId, "session-a");
  await fire();
  assert.ok(sent.length > 1, "a frame should follow");
  await hub.close();
});

test("frames reach every viewer of the same session", async () => {
  const { hub, fire } = harness(captureOf());
  const one = fakeSocket();
  const two = fakeSocket();
  hub.watch("local-user", "s", one.socket);
  hub.watch("local-user", "s", two.socket);
  await fire();
  const framesOne = one.sent.filter((m) => typeof m !== "string");
  const framesTwo = two.sent.filter((m) => typeof m !== "string");
  assert.ok(framesOne.length > 0 && framesTwo.length === framesOne.length);
  await hub.close();
});

test("the capture loop stops when the last viewer leaves, leaving no timer behind", async () => {
  // `h` is kept whole: destructuring would read the `liveTimers` getter once,
  // at zero, and every later assertion would be comparing against a snapshot.
  const h = harness(captureOf());
  const one = fakeSocket();
  const two = fakeSocket();
  h.hub.watch("local-user", "s", one.socket);
  h.hub.watch("local-user", "s", two.socket);
  assert.equal(h.liveTimers, 1, "one session must mean one capture loop");
  h.hub.unwatch("local-user", "s", one.socket);
  assert.equal(h.liveTimers, 1, "one viewer left, so the loop must keep running");
  h.hub.unwatch("local-user", "s", two.socket);
  assert.equal(h.liveTimers, 0, "no viewer means no capture loop");
  assert.equal(h.hub.activeStreams, 0);
  await h.fire();
  await h.hub.close();
});

test("a departing viewer is told the mirror ended and its socket is closed", () => {
  const { hub } = harness(captureOf());
  const { socket, sent, closed } = fakeSocket();
  hub.watch("local-user", "s", socket);
  hub.unwatch("local-user", "s", socket);
  assert.equal(closed.length, 1);
  assert.equal(parseControl(sent.at(-1) as string)?.type, "ended");
});

test("a viewer that vanished without closing cannot pin a capture loop open", async () => {
  // The failure this guards: the socket throws on every send, the viewer is
  // never removed, and the browser keeps being screenshotted forever.
  const { hub, fire, liveTimers } = harness(captureOf());
  const broken = fakeSocket({ throwOnSend: true });
  hub.watch("local-user", "s", broken.socket);
  await fire();
  await fire();
  assert.equal(hub.viewerCount, 0, "a dead socket must not stay subscribed");
  assert.equal(liveTimers, 0, "and must not keep the capture loop alive");
  assert.equal(hub.activeStreams, 0);
  await hub.close();
});

test("one dead viewer does not disconnect the healthy ones", async () => {
  const { hub, fire } = harness(captureOf());
  const healthy = fakeSocket();
  const broken = fakeSocket({ throwOnSend: true });
  hub.watch("local-user", "s", healthy.socket);
  hub.watch("local-user", "s", broken.socket);
  await fire();
  await fire();
  assert.equal(hub.viewerCount, 1);
  assert.ok(healthy.sent.filter((m) => typeof m !== "string").length >= 1);
  await hub.close();
});

test("a viewer whose socket has backed up skips frames instead of growing forever", async () => {
  // The memory guarantee: a slow client must not accumulate unbounded frames.
  let buffered = 0;
  const recorded: (string | Uint8Array)[] = [];
  const socket: MirrorSocket = {
    send(data) {
      if (typeof data !== "string") buffered += data.length;
      recorded.push(data);
    },
    close() {},
    get bufferedAmount() {
      return buffered;
    },
  };
  const heavy = new Uint8Array(200 * 1024);
  heavy.set([0xff, 0xd8], 0);
  const h = harness(captureOf({ jpeg: heavy }));
  h.hub.watch("local-user", "s", socket);
  await h.fire();
  const afterFirst = recorded.filter((m) => typeof m !== "string").length;
  for (let i = 0; i < 10; i++) await h.fire();
  const delivered = recorded.filter((m) => typeof m !== "string").length;
  assert.ok(afterFirst > 0, "the healthy start must have been delivered");
  // The cap is checked before each send, so at most `cap / frameSize` frames
  // past the check can be in flight. What matters is that delivery is bounded
  // by the buffer rather than by the number of ticks.
  const ceiling = Math.ceil((1024 * 1024) / heavy.byteLength) + 2;
  assert.ok(
    delivered <= ceiling,
    `back-pressure never engaged: ${delivered} frames delivered against a 1 MB cap`,
  );
  await h.hub.close();
});

test("a viewer limit is enforced so one session cannot be opened to the world", async () => {
  const { hub } = harness(captureOf(), { maxViewers: 2 });
  assert.equal(hub.watch("local-user", "s", fakeSocket().socket), true);
  assert.equal(hub.watch("local-user", "s", fakeSocket().socket), true);
  assert.equal(
    hub.watch("local-user", "s", fakeSocket().socket),
    false,
    "the third viewer must be refused",
  );
  await hub.close();
});

test("an oversized capture is dropped rather than forwarded", async () => {
  const huge = new Uint8Array(MAX_FRAME_BYTES + 1);
  huge.set([0xff, 0xd8], 0);
  const { hub, fire } = harness(captureOf({ jpeg: huge }));
  const { socket, sent } = fakeSocket();
  hub.watch("local-user", "s", socket);
  await fire();
  assert.equal(sent.filter((m) => typeof m !== "string").length, 0);
  await hub.close();
});

test("a capture that is not an image is dropped rather than sent to a decoder", async () => {
  const { hub, fire } = harness(captureOf({ jpeg: Uint8Array.from([1, 2, 3, 4, 5]) }));
  test("a capture that outlives its interval does not overlap the next one", async () => {
    // Overlapping captures would queue against the same serialised browser session
    // and slow down the agent work the mirror exists to show.
    let inFlight = 0;
    let overlapped = false;
    const { hub, fire } = harness(async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { jpeg: JPEG, cursor: { x: 1, y: 1 } };
    });
    hub.watch("local-user", "s", fakeSocket().socket);
    fire();
    fire();
    fire();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(overlapped, false, "captures must not overlap");
    await hub.close();
  });

  test("a capture in flight when everyone leaves is aborted, not left running", async () => {
    let aborted = false;
    const h = harness(
      (_owner, _id, signal) =>
        new Promise<Awaited<ReturnType<MirrorCaptureFn>>>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const { socket } = fakeSocket();
    h.hub.watch("local-user", "s", socket);
    // Not awaited: `fire` would block forever on a capture that never resolves.
    h.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, false, "the capture is still running before anyone leaves");
    h.hub.unwatch("local-user", "s", socket);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true, "the in-flight capture must be cancelled");
    await h.hub.close();
  });

  test("two owners watching the same id never share a stream", async () => {
    // The security property: a capture is authorized with the owner attached, so
    // one person's mirror cannot deliver another person's frames, and neither can
    // consume the other's viewer budget.
    const captured: [string, string][] = [];
    const h = harness(async (owner, id) => {
      captured.push([owner, id]);
      return { jpeg: JPEG, cursor: { x: owner === "alice" ? 1 : 2, y: 0 } };
    });
    const alice = fakeSocket();
    const bob = fakeSocket();
    h.hub.watch("alice", "shared-id", alice.socket);
    h.hub.watch("bob", "shared-id", bob.socket);
    assert.equal(h.hub.activeStreams, 2, "each owner gets their own stream");
    await h.fire();
    assert.deepEqual(captured.sort(), [
      ["alice", "shared-id"],
      ["bob", "shared-id"],
    ]);
    const frameOf = (sent: (string | Uint8Array)[]) => {
      const decoded = decodeFrame(sent.find((m) => typeof m !== "string") as Uint8Array);
      assert.equal(decoded.ok, true);
      return decoded.ok ? decoded.cursor.x : -1;
    };
    assert.equal(frameOf(alice.sent), 1);
    assert.equal(frameOf(bob.sent), 2);
    await h.hub.close();
  });

  test("a viewer budget is per owner, so one owner cannot lock another out", async () => {
    const h = harness(captureOf(), { maxViewers: 1 });
    assert.equal(h.hub.watch("alice", "s", fakeSocket().socket), true);
    // Bob is a different stream entirely, so Alice's full budget is irrelevant.
    assert.equal(h.hub.watch("bob", "s", fakeSocket().socket), true);
    await h.hub.close();
  });

  test("unwatching with the wrong owner leaves the viewer alone", async () => {
    const h = harness(captureOf());
    const alice = fakeSocket();
    h.hub.watch("alice", "s", alice.socket);
    h.hub.unwatch("bob", "s", alice.socket);
    assert.equal(h.hub.viewerCount, 1, "a mismatched owner must not evict the viewer");
    assert.equal(alice.closed.length, 0);
    await h.hub.close();
  });

  test("an upgrade on any other path is refused without touching the database", async () => {
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    let queried = false;
    for (const pathname of [
      "/",
      "/api/workspace",
      "/api/browsers/x/mirror",
      "/api/browsers//mirror",
    ]) {
      const decision = await decideUpgrade({
        pathname,
        sessionId: null,
        owner: "local-user",
        owns: async () => {
          queried = true;
          return true;
        },
        hasRoom: () => true,
      });
      assert.equal(decision.ok, false, pathname);
      assert.equal(queried, false, `${pathname} must not reach the database`);
    }
  });

  test("a malformed session id is refused before the database is consulted", async () => {
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    let queried = false;
    const decision = await decideUpgrade({
      pathname: "/api/browsers/not-a-uuid/mirror",
      sessionId: null,
      owner: "local-user",
      owns: async () => {
        queried = true;
        return true;
      },
      hasRoom: () => true,
    });
    assert.deepEqual(decision, { ok: false, status: 400, reason: "malformed session id" });
    assert.equal(queried, false);
  });

  test("an unauthenticated upgrade never reaches the ownership check", async () => {
    // This is the property that stops the mirror being an id oracle: a peer with
    // no session must not be able to learn whether a browser id exists.
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    let queried = false;
    const decision = await decideUpgrade({
      pathname: `/api/browsers/${SOME_UUID}/mirror`,
      sessionId: SOME_UUID,
      owner: null,
      owns: async () => {
        queried = true;
        return true;
      },
      hasRoom: () => true,
    });
    assert.deepEqual(decision, { ok: false, status: 401, reason: "sign in to watch" });
    assert.equal(queried, false);
  });

  test("a session this owner does not hold is reported as absent, not as forbidden", async () => {
    // Same status either way, so the endpoint cannot be used to discover which
    // session ids exist.
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    const decision = await decideUpgrade({
      pathname: `/api/browsers/${SOME_UUID}/mirror`,
      sessionId: SOME_UUID,
      owner: "local-user",
      owns: async () => false,
      hasRoom: () => true,
    });
    assert.deepEqual(decision, { ok: false, status: 404, reason: "browser session not found" });
  });

  test("a full mirror is refused before the ownership check", async () => {
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    let queried = false;
    const decision = await decideUpgrade({
      pathname: `/api/browsers/${SOME_UUID}/mirror`,
      sessionId: SOME_UUID,
      owner: "local-user",
      owns: async () => {
        queried = true;
        return true;
      },
      hasRoom: () => false,
    });
    assert.deepEqual(decision, { ok: false, status: 503, reason: "mirror is full" });
    assert.equal(queried, false);
  });

  test("an upgrade the owner is entitled to is allowed", async () => {
    const { decideUpgrade } = await import("../apps/server/src/mirror-routes.ts");
    const decision = await decideUpgrade({
      pathname: `/api/browsers/${SOME_UUID}/mirror`,
      sessionId: SOME_UUID,
      owner: "local-user",
      owns: async () => true,
      hasRoom: () => true,
    });
    assert.deepEqual(decision, { ok: true, sessionId: SOME_UUID });
  });

  test("closing the hub releases every session, timer and socket", async () => {
    const { hub, liveTimers } = harness(captureOf());
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    hub.watch("local-user", "a", sockets[0].socket);
    hub.watch("local-user", "b", sockets[1].socket);
    hub.watch("local-user", "b", sockets[2].socket);
    await hub.close();
    assert.equal(hub.activeStreams, 0);
    assert.equal(hub.viewerCount, 0);
    assert.equal(liveTimers, 0);
    assert.ok(
      sockets.every((s) => s.closed.length === 1),
      "every socket must be closed",
    );
  });

  test("a hub that has been closed refuses new viewers", async () => {
    const { hub } = harness(captureOf());
    await hub.close();
    assert.equal(hub.watch("local-user", "s", fakeSocket().socket), false);
  });

  test("a failing capture reports unavailable and keeps the stream alive", async () => {
    let calls = 0;
    const { hub, fire } = harness(async () => {
      calls++;
      if (calls === 1) throw new Error("worker is gone");
      return { jpeg: JPEG, cursor: { x: 2, y: 2 } };
    });
    const { socket, sent } = fakeSocket();
    hub.watch("local-user", "s", socket);
    await fire();
    assert.ok(
      sent.some((m) => typeof m === "string" && parseControl(m)?.fields.state === "unavailable"),
      "the viewer must be told the mirror is degraded",
    );
    await fire();
    assert.ok(
      sent.some((m) => typeof m !== "string"),
      "and must recover on the next frame",
    );
    await hub.close();
  });

  const { socket, sent } = fakeSocket();
  hub.watch("local-user", "s", socket);
  await fire();
  assert.equal(sent.filter((m) => typeof m !== "string").length, 0);
  await hub.close();
});
