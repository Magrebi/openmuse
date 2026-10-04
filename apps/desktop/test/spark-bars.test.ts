import assert from "node:assert/strict";
import { test } from "node:test";
import { SPARK_WIDTH, sparkBars } from "../src/control.js";

test("bar heights run from the floor to the peak", () => {
  // y grows downward, so the floor is a height of 0 and the top is 1.
  assert.deepEqual(sparkBars([{ y: 0 }], 11), [1]);
  assert.deepEqual(sparkBars([{ y: 10 }], 11), [0]);
  assert.deepEqual(sparkBars([{ y: 5 }], 11), [0.5]);
});

test("bar heights stay within the unit range", () => {
  const height = 16;
  const bars = sparkBars([{ y: -5 }, { y: 999 }, { y: 8 }], height);
  for (const bar of bars) {
    assert.ok(bar >= 0 && bar <= 1, `${bar} is outside 0..1`);
  }
});

test("an idle window draws no bars at all", () => {
  // The controller decides this, but the mapping itself must survive an empty
  // input rather than inventing a full row of minimum-height stubs.
  assert.deepEqual(sparkBars([], 16), []);
});

test("a one-pixel box does not divide by zero", () => {
  const bars = sparkBars([{ y: 0 }, { y: 1 }], 1);
  for (const bar of bars) assert.ok(Number.isFinite(bar));
});

test("every bar for a full-height window is drawable", () => {
  const bars = sparkBars(
    Array.from({ length: SPARK_WIDTH }, () => ({ y: 0 })),
    SPARK_WIDTH,
  );
  assert.equal(bars.length, SPARK_WIDTH);
  assert.ok(bars.every((bar) => bar === 1));
});
