import assert from "node:assert/strict";
import { test } from "node:test";
import { DeploymentController } from "../src/control.js";
import { composeFailure, fakePlatform, healthy, paths, refused } from "./helpers/fake-platform.js";

const build = (fake: ReturnType<typeof fakePlatform>, over = {}) =>
  new DeploymentController({
    ports: fake.ports,
    paths,
    mode: "host" as const,
    fetchImpl: fake.fetchImpl,
    ...over,
  });

test("an unreachable API at launch probes to stopped", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  assert.equal(app.state.state, "stopped");
  await app.stopAll();
});

test("a running deployment is detected at launch", async () => {
  const fake = fakePlatform();
  const app = build(fake);
  await app.probe();
  assert.equal(app.state.state, "healthy");
  await app.stopAll();
});

test("start drives stopped to starting, then a healthy poll reaches healthy", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  assert.equal(app.state.state, "stopped");

  await app.up(false);
  assert.equal(app.state.state, "starting");

  fake.setHealth(() => healthy());
  await app.pollHealth();
  assert.equal(app.state.state, "healthy");
  // The local web UI opens once, on loopback only.
  assert.deepEqual(fake.recorded.webviews, ["http://127.0.0.1:8081/"]);
  await app.stopAll();
});

test("a compose failure moves to error with one actionable line", async () => {
  const fake = fakePlatform({
    health: refused,
    runResult: composeFailure("Cannot connect to the Docker daemon"),
  });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  assert.equal(app.state.state, "error");
  assert.equal(app.state.reason, "Docker is not running. Start Docker Desktop, then try again.");
  // A sentence, never a stack trace.
  assert.ok(!app.state.reason?.includes("    at "));
  await app.stopAll();
});

test("a busy port and a missing token get their own fixes", async () => {
  const port = fakePlatform({
    health: refused,
    runResult: composeFailure("port is already allocated"),
  });
  const portApp = build(port);
  await portApp.probe();
  await portApp.up();
  assert.match(portApp.state.reason ?? "", /already in use/);
  await portApp.stopAll();

  const token = fakePlatform({
    health: refused,
    runResult: composeFailure("WORKER_TOKEN: required"),
  });
  const tokenApp = build(token);
  await tokenApp.probe();
  await tokenApp.up();
  assert.match(tokenApp.state.reason ?? "", /Setup wizard/);
  await tokenApp.stopAll();
});

test("unknown compose output still yields a single line", async () => {
  const fake = fakePlatform({ health: refused, runResult: composeFailure("some novel failure") });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  assert.equal(app.state.state, "error");
  assert.equal(app.state.reason, "Could not start browser-worker. Open the Logs tab for details.");
  await app.stopAll();
});
