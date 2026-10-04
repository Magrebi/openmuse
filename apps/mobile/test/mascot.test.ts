import assert from "node:assert/strict";
import { test } from "node:test";
import {
  celebrationDurationMs,
  mascotFrame,
  mascotLabel,
  mascotPosture,
  mascotSpring,
  mascotStates,
  resolveMascotState,
} from "../src/mascot.ts";
import { springs } from "../src/motion.ts";

test("a person speaking outranks every other signal, including a running task", () => {
  assert.equal(
    resolveMascotState({ listening: true, working: true, browsing: true, streaming: true }),
    "listening",
  );
});

test("a task blocked on the person reads as waiting, not as working", () => {
  assert.equal(
    resolveMascotState({ awaitingInput: true, working: true, streaming: true }),
    "waiting",
  );
});

test("a win is legible before it decays, even while other work is running", () => {
  assert.equal(
    resolveMascotState({ justSucceeded: true, working: true, streaming: true }),
    "celebrating",
  );
});

test("work is shown as thinking whether or not tokens are arriving", () => {
  assert.equal(resolveMascotState({ streaming: true }), "thinking");
  assert.equal(resolveMascotState({ working: true }), "thinking");
});

test("browsing is only claimed when nothing more urgent is happening", () => {
  assert.equal(resolveMascotState({ browsing: true }), "browsing");
  assert.equal(resolveMascotState({ browsing: true, streaming: true }), "thinking");
});

test("an unreachable agent looks like it is waiting, and nothing at all looks idle", () => {
  assert.equal(resolveMascotState({ offline: true }), "waiting");
  assert.equal(resolveMascotState({}), "idle");
});

test("every state resolves and produces a complete, in-range posture", () => {
  for (const state of mascotStates) {
    const posture = mascotPosture(state);
    assert.equal(posture.state, state);
    assert.ok(Number.isFinite(posture.scale) && posture.scale > 0, `${state} scale`);
    assert.ok(Number.isFinite(posture.bob), `${state} bob`);
    assert.ok(Number.isFinite(posture.tilt), `${state} tilt`);
    assert.ok(posture.breathPeriodMs > 0, `${state} breath period`);
    assert.ok(posture.eyeOpen >= 0 && posture.eyeOpen <= 1, `${state} eye`);
    assert.ok(posture.aura >= 0 && posture.aura <= 1, `${state} aura`);
    assert.match(posture.tint, /^#[0-9A-Fa-f]{6}$/, `${state} tint`);
    assert.ok(mascotLabel(state).length > 0, `${state} label`);
  }
});

test("no frame can ever produce a non-finite or out-of-range value for the renderer", () => {
  // The renderer passes these straight into transform props. A NaN here freezes
  // the mascot, so every state is sampled across a wide clock range.
  for (const state of mascotStates) {
    for (let time = 0; time < 12_000; time += 97) {
      const frame = mascotFrame(state, time);
      for (const [key, value] of Object.entries(frame)) {
        if (typeof value !== "number") continue;
        assert.ok(Number.isFinite(value), `${state}.${key} was ${value} at ${time}ms`);
      }
      assert.ok(frame.eyeOpen >= 0 && frame.eyeOpen <= 1, `${state} eye at ${time}ms`);
      assert.ok(frame.aura >= 0 && frame.aura <= 1, `${state} aura at ${time}ms`);
      assert.ok(frame.bob >= -0.4 && frame.bob <= 0.4, `${state} bob at ${time}ms`);
    }
  }
});

test("a frame sampled at a broken clock still renders instead of vanishing", () => {
  for (const state of mascotStates) {
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const frame = mascotFrame(state, time);
      assert.ok(Number.isFinite(frame.bob) && Number.isFinite(frame.scale), `${state} @ ${time}`);
    }
  }
});

test("the mascot actually moves: a full breath cycle is not a still image", () => {
  for (const state of mascotStates) {
    const period = mascotPosture(state).breathPeriodMs;
    const samples = [0, period / 4, period / 2, (period * 3) / 4].map(
      (t) => mascotFrame(state, t).bob,
    );
    const spread = Math.max(...samples) - Math.min(...samples);
    assert.ok(
      spread > mascotPosture(state).bob * 0.5,
      `${state} barely moves: spread ${spread.toFixed(5)}`,
    );
  }
});

test("a celebration hops once and the hop decays, while the breathing continues", () => {
  const duration = celebrationDurationMs("celebrating");
  assert.ok(duration > 0, "a celebration must be given a real duration to return from");
  assert.equal(celebrationDurationMs("idle"), 0, "only a celebration has a duration");

  // The hop is layered on top of the breathing, so the absolute bob never
  // reaches zero — the figure is alive throughout. What has to decay is the
  // *extra* travel the celebration added, so compare the peak excursion inside
  // the gesture against the steady breathing amplitude after it is over.
  const peak = (from: number, to: number) =>
    Math.max(
      ...Array.from({ length: to - from + 1 }, (_, i) =>
        Math.abs(mascotFrame("celebrating", from + i).bob),
      ),
    );
  const gesture = peak(0, duration);
  const afterwards = peak(duration * 2, duration * 2 + 2000);
  assert.ok(gesture > 0.2, `the celebration did not visibly hop: ${gesture}`);
  assert.ok(afterwards < gesture * 0.25, `the hop never decayed: ${afterwards} vs ${gesture}`);

  // And it peaks once rather than repeating, so it cannot read as a metronome.
  const secondWindow = Math.max(
    ...[1400, 1700, 2000, 2300].map((t) => Math.abs(mascotFrame("celebrating", t).bob)),
  );
  assert.ok(secondWindow < gesture, "the celebration repeated instead of settling");
});

test("states are visually distinct, so state is readable without text", () => {
  const postures = mascotStates.map((state) => mascotPosture(state));
  const breathPeriods = new Set(postures.map((p) => p.breathPeriodMs));
  assert.equal(
    breathPeriods.size,
    postures.length,
    "two states share a breath rate and would look identical",
  );
  const tints = new Set(postures.map((p) => p.tint));
  assert.ok(tints.size >= 5, "states are barely distinguishable by colour");
});

test("a celebration uses the spring that carries momentum, and nothing else does", () => {
  assert.equal(mascotSpring("celebrating"), springs.shared);
  assert.equal(mascotSpring("idle"), springs.gentle);
  assert.equal(mascotSpring("waiting"), springs.gentle);
});
