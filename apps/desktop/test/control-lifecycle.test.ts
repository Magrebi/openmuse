import assert from "node:assert/strict";
import { test } from "node:test";
import { DeploymentController } from "../src/control.js";
import type { Clock } from "../src/platform.js";
import { fakePlatform, healthy, paths, refused } from "./helpers/fake-platform.js";

const build = (fake: ReturnType<typeof fakePlatform>, over = {}) =>
  new DeploymentController({
    ports: fake.ports,
    paths,
    mode: "host" as const,
    fetchImpl: fake.fetchImpl,
    ...over,
  });

test("stop preserves volumes because no command ever passes -v", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  fake.setHealth(() => healthy());
  await app.pollHealth();
  assert.equal(app.state.state, "healthy");

  await app.down();
  assert.equal(app.state.state, "stopped");
  assert.ok(fake.recorded.commands.length > 0);
  for (const command of fake.recorded.commands) {
    assert.ok(!command.args.includes("-v"), "volume deletion must never be issued");
    assert.ok(!command.args.includes("--volumes"), "volume deletion must never be issued");
  }
  // Data survives: the teardown is a plain `docker compose down`.
  const down = fake.recorded.commands.find((command) => command.args.includes("down"));
  assert.deepEqual(down?.args.slice(-1), ["down"]);
});

test("host mode starts the API and web UI as local processes", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  const pnpm = fake.recorded.commands.filter((command) => command.program === "pnpm");
  assert.deepEqual(
    pnpm.map((command) => command.args),
    [["dev"], ["--dir", "apps/mobile", "web"]],
  );
  // The browser worker is containerized in both modes.
  assert.ok(fake.recorded.commands.some((command) => command.program === "docker"));
  await app.stopAll();
});

test("container mode starts the whole stack through one compose call", async () => {
  const fake = fakePlatform({ health: refused });
  const app = new DeploymentController({
    ports: fake.ports,
    paths,
    mode: "container",
    fetchImpl: fake.fetchImpl,
  });
  await app.probe();
  await app.up(false);
  assert.equal(fake.recorded.commands.filter((command) => command.program === "pnpm").length, 0);
  const up = fake.recorded.commands.find((command) => command.args.includes("up"));
  assert.deepEqual(up?.args, [
    "compose",
    "-f",
    "infra/compose.yaml",
    "--env-file",
    ".env",
    "up",
    "--build",
    "-d",
  ]);
  await app.stopAll();
});

test("the tray and notifications follow the machine, with one copy of state", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  const seen: string[] = [];
  app.subscribe((deployment) => seen.push(deployment.state));
  assert.deepEqual(seen, ["unknown"], "a subscriber is called immediately");

  await app.probe();
  assert.ok(fake.recorded.tray.some((entry) => entry.tooltip.includes("stopped")));

  fake.setHealth(() => healthy());
  await app.up(false);
  await app.pollHealth();
  assert.deepEqual(seen, ["unknown", "stopped", "starting", "healthy"]);
  assert.ok(fake.recorded.notifications.includes("OpenMuse is running."));
  for (const entry of fake.recorded.tray)
    assert.ok(["gray", "green", "amber", "red"].includes(entry.tone));
  await app.stopAll();
});

test("a degraded stack is announced once and shows amber", async () => {
  const fake = fakePlatform({ health: () => healthy({ browserConfigured: false }) });
  const app = build(fake);
  await app.probe();
  assert.equal(app.state.state, "degraded");
  assert.ok(fake.recorded.notifications.some((body) => body.includes("WORKER_TOKEN")));
  assert.ok(fake.recorded.tray.some((entry) => entry.tone === "amber"));
  await app.stopAll();
});

test("an API that dies after a healthy start degrades rather than erroring", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  fake.setHealth(() => healthy());
  await app.pollHealth();
  assert.equal(app.state.state, "healthy");

  fake.setHealth(refused);
  await app.pollHealth();
  assert.equal(app.state.state, "degraded");
  await app.stopAll();
});

test("every command runs inside the repository directory", async () => {
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  await app.probe();
  await app.up(false);
  await app.down();
  for (const command of fake.recorded.commands) assert.equal(command.cwd, "/repo");
});

test("a stack that never answers fails on the start timeout", async () => {
  const fake = fakePlatform({ health: refused });
  let now = 0;
  const clock: Clock = { now: () => now };
  const app = build(fake, { clock, startTimeoutMs: 1000 });
  await app.probe();
  await app.up(false);

  now = 500;
  await app.pollHealth();
  assert.equal(app.state.state, "starting", "still booting before the timeout");

  now = 2000;
  await app.pollHealth();
  assert.equal(app.state.state, "error");
  assert.equal(app.state.code, "COMPOSE_TIMEOUT");
  await app.stopAll();
});

test("secrets are redacted out of captured service output", async () => {
  const secret = "worker-secret-value-1234";
  const fake = fakePlatform();
  const app = build(fake);
  app.setSecrets([secret]);
  const lines: string[] = [];
  app.sink = (line) => lines.push(line);
  app.appendLog("api", `starting with WORKER_TOKEN=${secret}\nready\n`);
  assert.deepEqual(lines, ["api: starting with WORKER_TOKEN=[redacted]", "api: ready"]);
  assert.ok(!lines.join("\n").includes(secret));
});

test("host service output is redacted before it reaches the viewer", async () => {
  const secret = "another-secret-value-99";
  const fake = fakePlatform({ health: refused });
  const app = build(fake);
  app.setSecrets([secret]);
  const lines: string[] = [];
  app.sink = (line) => lines.push(line);
  await app.probe();
  await app.up(false);
  for (const child of fake.recorded.spawned) child.sink.write(`token=${secret}\n`);
  assert.ok(lines.length > 0);
  assert.ok(!lines.join("\n").includes(secret));
  await app.stopAll();
});
