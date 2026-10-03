import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingFailures,
  type CheckId,
  type CheckResult,
  checkPrerequisites,
  type PrerequisiteProbes,
  prerequisiteSummary,
} from "../src/prerequisites.js";

/** Per-port overrides, keyed by the CheckId that reports that port. */
type Overrides = Partial<Record<CheckId, boolean>>;

const probes = (over: Overrides = {}): PrerequisiteProbes => ({
  dockerCli: async () => over["docker-cli"] ?? true,
  dockerDaemon: async () => over["docker-daemon"] ?? true,
  composePlugin: async () => over["compose-plugin"] ?? true,
  envFile: async () => over["env-file"] ?? true,
  portInUse: async (port) => over[portKey(port)] ?? false,
});

const portKey = (port: number): CheckId =>
  port === 8787 ? "api-port" : port === 8081 ? "web-port" : "worker-port";

const find = (results: CheckResult[], id: CheckId) => results.find((result) => result.id === id);

test("a ready machine passes every check", async () => {
  const results = await checkPrerequisites(probes());
  assert.deepEqual(blockingFailures(results), []);
  assert.equal(prerequisiteSummary(results), undefined);
});

test("a stopped Docker Desktop produces one clear line, not a stack trace", async () => {
  const results = await checkPrerequisites(probes({ "docker-daemon": false }));
  const fix = find(results, "docker-daemon")?.fix;
  assert.equal(fix, "Start Docker Desktop and try again.");
  assert.equal(prerequisiteSummary(results), fix);
});

test("a missing Docker install skips the checks that depend on it", async () => {
  const results = await checkPrerequisites(probes({ "docker-cli": false }));
  assert.equal(find(results, "docker-cli")?.status, "failed");
  assert.equal(find(results, "docker-daemon")?.status, "skipped");
  assert.equal(find(results, "compose-plugin")?.status, "skipped");
});

test("a busy port names the port and suggests a fix", async () => {
  const results = await checkPrerequisites(probes({ "web-port": true }));
  const fix = find(results, "web-port")?.fix ?? "";
  assert.ok(fix.startsWith("Port 8081 is already in use."));
  assert.ok(!fix.includes("Error:"), "no stack trace in the message");
});

test("all three ports are checked", async () => {
  const results = await checkPrerequisites(probes());
  for (const id of ["api-port", "web-port", "worker-port"] as const)
    assert.ok(find(results, id), `${id} must be checked`);
});

test("a missing .env points at the setup wizard", async () => {
  const results = await checkPrerequisites(probes({ "env-file": false }));
  assert.equal(find(results, "env-file")?.fix, "Run the Setup wizard to create the .env file.");
});

test("a probe that throws is reported as a failure, not an exception", async () => {
  const results = await checkPrerequisites({
    ...probes(),
    dockerCli: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  assert.equal(find(results, "docker-cli")?.status, "failed");
  assert.ok(find(results, "docker-cli")?.fix);
});

test("every failed check carries exactly one line of advice", async () => {
  const results = await checkPrerequisites(
    probes({ "docker-cli": false, "env-file": false, "api-port": true }),
  );
  for (const failure of blockingFailures(results)) {
    assert.ok(failure.fix, `${failure.id} needs a fix`);
    assert.ok(!failure.fix.includes("\n"), "a fix is one line");
    assert.ok(failure.fix.length < 120, "a fix is short");
  }
});
