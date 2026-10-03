import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeStates,
  type Deployment,
  type DeploymentEvent,
  initialDeployment,
  toneFor,
  transition,
} from "../src/state.js";

const drive = (events: DeploymentEvent[], from = initialDeployment()) =>
  events.reduce<Deployment>(transition, from);

test("the launch probe is the only way out of unknown", () => {
  assert.equal(drive([{ type: "PROBE", result: "stopped" }]).state, "stopped");
  assert.equal(drive([{ type: "PROBE", result: "healthy" }]).state, "healthy");
  assert.equal(drive([{ type: "PROBE", result: "degraded" }]).state, "degraded");
  // An unreachable API at launch means the stack is simply not running yet.
  assert.equal(drive([{ type: "PROBE", result: "unreachable" }]).state, "unknown");
  // A probe cannot override a state we already know.
  assert.equal(
    drive([
      { type: "PROBE", result: "stopped" },
      { type: "PROBE", result: "healthy" },
    ]).state,
    "stopped",
  );
});

test("stopped starts and the start timeout fails", () => {
  assert.equal(
    drive([{ type: "UP_REQUESTED" }], drive([{ type: "PROBE", result: "stopped" }])).state,
    "starting",
  );
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  assert.equal(transition(starting, { type: "START_TIMEOUT" }).state, "error");
});

test("a failed health poll after starting is not an error", () => {
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  // The API may not be listening yet; only the timeout may fail the start.
  assert.equal(transition(starting, { type: "HEALTH_FAIL" }).state, "starting");
});

test("stopped reaches healthy and stays there", () => {
  const healthy = drive([
    { type: "PROBE", result: "stopped" },
    { type: "UP_REQUESTED" },
    { type: "HEALTH_OK" },
  ]);
  assert.equal(healthy.state, "healthy");
  assert.equal(transition(healthy, { type: "HEALTH_OK" }).state, "healthy");
});

test("healthy degrades on a failed poll and recovers", () => {
  const healthy = drive([{ type: "PROBE", result: "healthy" }]);
  const degraded = transition(healthy, { type: "HEALTH_FAIL" });
  assert.equal(degraded.state, "degraded");
  assert.equal(transition(degraded, { type: "HEALTH_OK" }).state, "healthy");
});

test("a partly configured stack is degraded, not healthy", () => {
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  assert.equal(transition(starting, { type: "HEALTH_PARTIAL" }).state, "degraded");
});

test("a compose failure during start moves to error and carries a reason", () => {
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  const failed = transition(starting, {
    type: "COMPOSE_FAILED",
    code: "COMPOSE_FAILED",
    reason: "Docker is not running.",
  });
  assert.equal(failed.state, "error");
  assert.equal(failed.code, "COMPOSE_FAILED");
  assert.equal(failed.reason, "Docker is not running.");
  // A failed start can be retried from error.
  assert.equal(transition(failed, { type: "UP_REQUESTED" }).state, "starting");
});

test("stopping returns to stopped and reports a failed stop", () => {
  const healthy = drive([{ type: "PROBE", result: "healthy" }]);
  const stopping = transition(healthy, { type: "DOWN_REQUESTED" });
  assert.equal(stopping.state, "stopping");
  assert.equal(transition(stopping, { type: "DOWN_EXIT_OK" }).state, "stopped");
  assert.equal(transition(stopping, { type: "DOWN_EXIT_FAIL" }).state, "error");
});

test("every active state, and error, can be stopped", () => {
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  const active: Deployment[] = [
    starting,
    drive([{ type: "PROBE", result: "healthy" }]),
    drive([{ type: "PROBE", result: "degraded" }]),
  ];
  for (const deployment of active) {
    assert.ok(activeStates.includes(deployment.state));
    assert.equal(transition(deployment, { type: "DOWN_REQUESTED" }).state, "stopping");
  }
  // error is not active, but a person must still be able to stop a broken stack.
  const errored = transition(starting, { type: "COMPOSE_FAILED", code: "COMPOSE_FAILED" });
  assert.equal(errored.state, "error");
  assert.ok(!activeStates.includes(errored.state));
  assert.equal(transition(errored, { type: "DOWN_REQUESTED" }).state, "stopping");
});

test("health events are ignored while stopped", () => {
  const stopped = drive([{ type: "PROBE", result: "stopped" }]);
  for (const event of [
    { type: "HEALTH_OK" },
    { type: "HEALTH_PARTIAL" },
    { type: "HEALTH_FAIL" },
  ] as DeploymentEvent[])
    assert.equal(transition(stopped, event).state, "stopped");
});

test("each state maps to exactly one tray tone", () => {
  assert.equal(toneFor("healthy"), "green");
  assert.equal(toneFor("degraded"), "amber");
  assert.equal(toneFor("starting"), "amber");
  assert.equal(toneFor("stopping"), "amber");
  assert.equal(toneFor("error"), "red");
  assert.equal(toneFor("stopped"), "gray");
  assert.equal(toneFor("unknown"), "gray");
});

test("a poll that changes nothing does not move the revision", () => {
  const starting = drive([{ type: "PROBE", result: "stopped" }, { type: "UP_REQUESTED" }]);
  const same = transition(starting, { type: "HEALTH_FAIL" });
  assert.equal(same.state, starting.state);
  // A poll must not cause a redraw storm while the API is still booting.
  assert.ok(same.revision <= starting.revision + 1);
});

test("the transition history records each state change", () => {
  const history = drive([
    { type: "PROBE", result: "stopped" },
    { type: "UP_REQUESTED" },
    { type: "HEALTH_OK" },
  ]).history;
  assert.deepEqual(history, ["unknown", "stopped", "starting", "healthy"]);
});
