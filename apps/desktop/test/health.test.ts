import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLoopback,
  classifyHealth,
  degradedFix,
  type HealthPayload,
  readHealth,
} from "../src/health.js";

/** Build a valid payload; only the fields a test cares about vary. */
const payload = (over: Partial<HealthPayload> = {}): HealthPayload => ({
  ok: true,
  mode: "sample",
  agentConfigured: true,
  browserConfigured: true,
  ...over,
});

const ok = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      ok: true,
      mode: "sample",
      agentConfigured: true,
      browserConfigured: true,
      ...over,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

test("a fully configured stack is healthy", () => {
  assert.equal(classifyHealth(payload()), "healthy");
});

test("a partly configured stack is degraded, with one actionable line", () => {
  const noAgent = payload({ agentConfigured: false });
  assert.equal(classifyHealth(noAgent), "degraded");
  assert.ok(degradedFix(noAgent)?.includes("provider key"));

  const noBrowser = payload({ mode: "live", browserConfigured: false });
  assert.equal(classifyHealth(noBrowser), "degraded");
  assert.ok(degradedFix(noBrowser)?.includes("WORKER_TOKEN"));

  assert.equal(degradedFix(payload()), undefined);
});

test("an ok response with the wrong shape is degraded, not healthy", async () => {
  const reading = await readHealth(
    "http://127.0.0.1:8787/api/health",
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  assert.equal(reading.probe, "degraded");
  assert.ok(reading.fix);
});

test("an error status yields a fix, not a stack trace", async () => {
  const reading = await readHealth(
    "http://127.0.0.1:8787/api/health",
    async () => new Response("nope", { status: 503 }),
  );
  assert.equal(reading.probe, "degraded");
  assert.equal(reading.fix, "The API answered 503. Check the API logs.");
});

test("an unreachable API is reported as unreachable with a fix", async () => {
  const reading = await readHealth("http://127.0.0.1:8787/api/health", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(reading.probe, "unreachable");
  assert.equal(reading.fix, "OpenMuse is not responding. Start it, then retry.");
});

test("a healthy response is parsed through the schema", async () => {
  const reading = await readHealth("http://127.0.0.1:8787/api/health", async () => ok());
  assert.equal(reading.probe, "healthy");
  assert.equal(reading.payload?.mode, "sample");
});

test("only loopback URLs are accepted", () => {
  assert.equal(assertLoopback("http://127.0.0.1:8081").hostname, "127.0.0.1");
  assert.equal(assertLoopback("http://localhost:8787").hostname, "localhost");
  for (const hostile of [
    "http://evil.example",
    "http://192.168.1.10:8787",
    "http://10.0.0.5",
    "not a url",
  ])
    assert.throws(() => assertLoopback(hostile), { name: "DesktopError", code: "HEALTH_INVALID" });
});
