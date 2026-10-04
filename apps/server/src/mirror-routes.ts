import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Auth } from "./auth.ts";
import type { BrowserService } from "./browser.ts";
import { backgroundFailure } from "./log.ts";
import { MirrorHub } from "./mirror.ts";

/**
 * The live mirror's WebSocket endpoint.
 *
 * A WebSocket upgrade never reaches a fetch handler — Hono sees nothing of it —
 * so the HTTP server has to be handed its own `upgrade` listener. That listener
 * authenticates before anything else happens, because once the upgrade is
 * accepted the peer is already talking to this process.
 */

const MIRROR_PATH = /^\/api\/browsers\/([^/]+)\/mirror$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What to do with an upgrade request. */
export type UpgradeDecision =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; reason: string };

/**
 * Decide what to do with an upgrade request.
 *
 * Pure, and takes the parsed pieces rather than the request, so every branch is
 * reachable from a test without opening a socket. The ordering *is* the
 * security policy, which is why it lives in one place and is tested as a whole:
 *
 * 1. Is the path even ours? Cheap, and rejects a probe.
 * 2. Is the session id shaped like one? Also cheap.
 * 3. Is there a valid session token? A missing or expired one never reaches the
 *    database — an unauthenticated peer must not be able to use this endpoint as
 *    an oracle for "does this id exist".
 * 4. Is there room? Checked before the database because a full mirror should
 *    fail fast rather than after a round trip.
 * 5. Does this owner own this session? Last, because it is the only check that
 *    costs anything.
 */
export const decideUpgrade = async (options: {
  pathname: string;
  sessionId: string | null;
  owner: string | null;
  owns: (sessionId: string) => Promise<boolean>;
  hasRoom: () => boolean;
}): Promise<UpgradeDecision> => {
  const match = MIRROR_PATH.exec(options.pathname);
  if (!match) return { ok: false, status: 404, reason: "not a mirror endpoint" };
  const sessionId = match[1];
  if (!SESSION_ID.test(sessionId))
    return { ok: false, status: 400, reason: "malformed session id" };
  if (!options.owner) return { ok: false, status: 401, reason: "sign in to watch" };
  if (!options.hasRoom()) return { ok: false, status: 503, reason: "mirror is full" };
  return (await options.owns(sessionId))
    ? { ok: true, sessionId }
    : { ok: false, status: 404, reason: "browser session not found" };
};

/**
 * The HTTP server the mirror attaches to.
 *
 * `@hono/node-server` types `serve`'s return as the union of an HTTP/1 and an
 * HTTP/2 server; only the HTTP/1 one emits `upgrade`, which is the only one this
 * process ever listens on. Accepting the union and narrowing at the boundary
 * keeps the cast here, where it is explained, rather than at every call site.
 */
type UpgradableServer = { on(event: "upgrade", listener: UpgradeListener): unknown };

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Attach the mirror endpoint to the Node server Hono is not serving directly.
 */
export function attachMirror(
  server: UpgradableServer,
  options: {
    browser: BrowserService;
    auth: Auth;
    intervalMs?: number;
  },
) {
  const hub = new MirrorHub(
    (owner, sessionId, signal) => options.browser.frame(owner, sessionId, signal),
    { intervalMs: options.intervalMs },
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  wss.on(
    "connection",
    (socket: import("ws").WebSocket, request: IncomingMessage, sessionId: string) => {
      // The owner is resolved once, here, and travels with the stream. Resolving
      // it again per frame would mean a session token that expires mid-watch
      // silently stops the frames for no reason the person could see.
      void options.auth
        .owner(request.headers.authorization)
        .then((owner) => {
          if (!owner) {
            socket.close(1008, "Session expired");
            return;
          }
          const viewer = {
            send: (data: string | Uint8Array) => {
              if (socket.readyState !== socket.OPEN) throw new Error("socket is not open");
              socket.send(data as Parameters<typeof socket.send>[0]);
            },
            get bufferedAmount() {
              return socket.bufferedAmount;
            },
            close: (code?: number, reason?: string) => socket.close(code, reason),
          };
          if (!hub.watch(owner, sessionId, viewer)) {
            socket.close(1013, "Mirror is full");
            return;
          }
          // Deregistration is bound to this socket's own lifecycle, so a viewer
          // cannot outlive its connection however it ended — a close frame, a
          // reset, or an error part-way through a frame.
          const release = () => hub.unwatch(owner, sessionId, viewer);
          socket.on("close", release);
          socket.on("error", release);
        })
        .catch(() => socket.close(1011, "Mirror failed to start"));
    },
  );

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    void (async () => {
      try {
        // Resolved exactly once per upgrade, then reused for both the
        // authorization check and the stream, so a session token cannot expire
        // between the two and produce a stream that silently stops.
        const owner = await options.auth.owner(request.headers.authorization).catch(() => null);
        const decision = await decideUpgrade({
          pathname,
          sessionId: MIRROR_PATH.exec(pathname)?.[1] ?? null,
          owner,
          owns: async (id) => {
            // A throw means "no such session for this owner", which `get`
            // expresses as a 404. Reporting it that way means this endpoint
            // cannot be used to probe for session ids.
            await options.browser.get(owner as string, id);
            return true;
          },
          hasRoom: () => true,
        });
        if (!decision.ok) {
          socket.write(`HTTP/1.1 ${decision.status} ${decision.reason}\r\n\r\n`);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
          wss.emit("connection", client, request, decision.sessionId);
        });
      } catch (error) {
        backgroundFailure("mirror upgrade", error);
        socket.destroy();
      }
    })();
  });

  return {
    hub,
    async close() {
      await hub.close();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
