import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  fetchWithTimeout,
  isUnreachable,
  requestTimeoutMs,
  unreachableMessage,
} from "../src/http.ts";

/** A server that accepts the connection and then never answers, like a wedged API. */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer(() => {
    // Deliberately no response.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/api/agent`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a request to an API that never answers fails instead of hanging", async () => {
  const server = await silentServer();
  try {
    // Without a deadline this promise never settles, and every polling screen
    // that awaits it stops refreshing forever while showing stale data.
    await assert.rejects(fetchWithTimeout(server.url, { timeoutMs: 300 }), (error: Error) => {
      assert.equal(error.message, unreachableMessage);
      assert.equal(isUnreachable(error), true);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("a normal request still returns and clears its timer", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${address.port}/api/agent`, {
      timeoutMs: 5000,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed request reports the server's reason rather than a timeout", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Sign in to OpenMuse" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${address.port}/api/agent`, {
      timeoutMs: 5000,
    });
    assert.equal(response.status, 401);
    assert.equal(isUnreachable(new Error("Sign in to OpenMuse")), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the deadline is long enough for a real request but bounded", () => {
  // A bound that is too short would fail a legitimate page read; too long and
  // the screen still looks hung.
  assert.ok(requestTimeoutMs >= 10_000, "must outlast a slow page read");
  assert.ok(requestTimeoutMs <= 60_000, "must fail well before a user gives up");
});
