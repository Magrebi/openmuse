import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeDown,
  composeLogs,
  composeUp,
  type DeploymentMode,
  dockerProgram,
  type RepoPaths,
  serviceNames,
  serviceStart,
  serviceStop,
} from "../src/deployment.js";

const paths: RepoPaths = {
  root: "/Users/ada/openmuse",
  composeFile: "infra/compose.yaml",
  envFile: ".env",
};

test("every command is an argv array, never a shell string", () => {
  const specs = [
    ...serviceNames.flatMap((service) => [
      serviceStart("host", service, paths),
      serviceStart("container", service, paths),
    ]),
    serviceStop("container", "browser-worker", paths),
  ].filter(Boolean) as { program: string; args: string[]; cwd: string }[];
  for (const spec of specs) {
    assert.ok(Array.isArray(spec.args), "args must be an array");
    for (const arg of spec.args) assert.equal(typeof arg, "string");
    // A shell string would contain quoting, pipes or redirects as one element.
    assert.ok(!spec.args.some((arg) => /[|;&><`$\n]/.test(arg)), `no shell syntax: ${spec.args}`);
    assert.equal(spec.cwd, paths.root);
  }
});

test("only docker and pnpm are ever invoked", () => {
  for (const mode of ["host", "container"] as DeploymentMode[])
    for (const service of serviceNames)
      assert.ok([dockerProgram, "pnpm"].includes(serviceStart(mode, service, paths).program));
});

test("the program is never taken from user input", () => {
  // A hostile value cannot reach the program name: it is selected by service.
  const spec = serviceStart("host", "api", paths);
  assert.equal(spec.program, "pnpm");
  assert.deepEqual(spec.args, ["dev"]);
});

test("volume deletion is unreachable from every stop path", () => {
  const down = composeDown(paths);
  assert.ok(!down.includes("-v"));
  assert.ok(!down.includes("--volumes"));
  assert.ok(!down.some((arg) => arg.startsWith("--volumes")));
  assert.equal(down[down.length - 1], "down");
});

test("up starts the whole compose stack detached with the env file", () => {
  assert.deepEqual(composeUp(paths), [
    "compose",
    "-f",
    "infra/compose.yaml",
    "--env-file",
    ".env",
    "up",
    "--build",
    "-d",
  ]);
});

test("logs follow one service and are tailed", () => {
  const args = composeLogs(paths, "browser-worker");
  assert.ok(args.includes("-f"));
  assert.ok(args.includes("--tail=200"));
  assert.equal(args[args.length - 1], "browser-worker");
});

test("host mode supervises the API and web UI locally", () => {
  assert.deepEqual(serviceStart("host", "api", paths).args, ["dev"]);
  assert.deepEqual(serviceStart("host", "web", paths).args, ["--dir", "apps/mobile", "web"]);
  // The browser worker is always containerized.
  assert.equal(serviceStart("host", "browser-worker", paths).program, dockerProgram);
});

test("host processes are signalled rather than spawned to stop", () => {
  assert.equal(serviceStop("host", "api", paths), null);
  assert.equal(serviceStop("host", "browser-worker", paths)?.program, dockerProgram);
});
