import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clamp,
  clamp01,
  lerp,
  normalize,
  sampleSpring,
  springs,
  stagger,
  stepSpring,
  wave,
} from "../src/motion.ts";

/**
 * The springs are tuned for pixel-scale values, so the tests use them too.
 *
 * The rest thresholds are 0.3px of displacement and 1.5px/frame of velocity. A
 * spring asked to travel *one* pixel is already inside its rest threshold on
 * frame one and correctly reports itself settled, so measuring "does this
 * overshoot" at unit scale would pass vacuously for every spring including the
 * ones that must not overshoot.
 */
const CARD_TRAVEL = 220;
const LINE_TRAVEL = 96;

test("a streaming height never overshoots its target, so arriving text does not jump", () => {
  const { overshoot, settledAtMs } = sampleSpring(springs.streaming, LINE_TRAVEL);
  assert.equal(overshoot, 0, "clamped springs must not cross the target");
  // A line of text arrives roughly every 280ms; the height must be visually
  // settled by then or the transcript visibly trails what the agent has said.
  assert.ok(
    settledAtMs !== null && settledAtMs <= 280,
    `a streaming height settled in ${settledAtMs}ms, too slow to keep up with text`,
  );
});

test("a stream of arriving lines never has more than one height in flight", () => {
  // Each line restarts the spring from wherever the last one got to. If that
  // never converges the box drifts upward forever, so assert the fixed point.
  let height = 0;
  for (let line = 0; line < 40; line++) {
    height += LINE_TRAVEL;
    for (let step = 0; step < 60; step++) {
      const next = stepSpring(springs.streaming, height, 0, 16 / 1000);
      height = next.displacement;
    }
  }
  assert.ok(height < 40, `residual height kept growing: ${height}`);
});

test("a shared-element spring overshoots, which is what makes the card feel physical", () => {
  const { overshoot, settledAtMs } = sampleSpring(springs.shared, CARD_TRAVEL);
  assert.ok(overshoot > 0.5, `the shared spring should carry past its target: ${overshoot}`);
  assert.ok(settledAtMs !== null, "the shared spring must come to rest");
});

test("a damped spring that never passes its target reports no overshoot at all", () => {
  const { overshoot } = sampleSpring(springs.gentle, CARD_TRAVEL);
  assert.equal(overshoot, 0, "gentle approaches the target without crossing it");
});

test("a sheet never bounces harder than a shared element does", () => {
  const sheet = sampleSpring(springs.gentle, CARD_TRAVEL);
  const card = sampleSpring(springs.shared, CARD_TRAVEL);
  assert.ok(
    sheet.overshoot < card.overshoot,
    "a wobbling sheet reads as broken; the card is what should carry momentum",
  );
});

test("the shared element settles sooner than a sheet does", () => {
  const press = sampleSpring(springs.snappy, CARD_TRAVEL);
  const sheet = sampleSpring(springs.gentle, CARD_TRAVEL);
  assert.ok((press.settledAtMs ?? Infinity) < (sheet.settledAtMs ?? Infinity));
});

test("a spring at rest stays at rest rather than drifting", () => {
  const sample = stepSpring(springs.gentle, 0, 0, 1 / 60);
  assert.equal(sample.displacement, 0);
  assert.equal(sample.velocity, 0);
  assert.equal(sample.settled, true);
});

test("a non-positive timestep never advances the spring, instead of exploding", () => {
  const still = stepSpring(springs.gentle, 40, 12, 0);
  assert.deepEqual(still, { displacement: 40, velocity: 12, settled: true });
  const backwards = stepSpring(springs.gentle, 40, 12, -1);
  assert.deepEqual(backwards, { displacement: 40, velocity: 12, settled: true });
});

test("sampling every spring reaches rest, so no surface animates forever", () => {
  for (const [name, spring] of Object.entries(springs)) {
    const { settledAtMs } = sampleSpring(spring, CARD_TRAVEL);
    assert.ok(settledAtMs !== null, `${name} never settled`);
    assert.ok(settledAtMs <= 4000, `${name} took ${settledAtMs}ms`);
  }
});

test("clamp helpers treat an infinity as out-of-range and only NaN as absent", () => {
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 1);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
  assert.equal(clamp(Number.NaN, 2, 8), 2);
  assert.equal(clamp(99, 2, 8), 8);
  assert.equal(clamp(5, 2, 8), 5);
  assert.equal(clamp(1, 2, 8), 2, "a value below the range clamps up to it");
  assert.equal(clamp(Number.POSITIVE_INFINITY, 2, 8), 8);
});

test("a degenerate range normalises to zero, never to NaN", () => {
  assert.equal(normalize(5, 5, 5), 0);
  assert.equal(normalize(5, 10, 0), 0, "a reversed range has no meaningful position");
  assert.equal(normalize(15, 10, 20), 0.5);
});

test("interpolation is the identity at both ends", () => {
  assert.equal(lerp(3, 9, 0), 3);
  assert.equal(lerp(3, 9, 1), 9);
  assert.equal(lerp(3, 9, 0.25), 4.5);
});

test("stagger caps a long list instead of stretching the entrance indefinitely", () => {
  assert.equal(stagger(0), 0);
  assert.equal(stagger(-4), 0, "a negative index is not a delay");
  assert.equal(stagger(3), 102);
  assert.equal(stagger(1000), 320);
});

test("the breathing oscillator is periodic and bounded", () => {
  assert.equal(wave(0, 1000), 0);
  assert.ok(Math.abs(wave(250, 1000) - 1) < 1e-9);
  assert.ok(Math.abs(wave(750, 1000) + 1) < 1e-9);
  assert.equal(wave(10, 0), 0, "a zero period has no defined phase");
  assert.equal(wave(Number.NaN, 1000), 0);
});
