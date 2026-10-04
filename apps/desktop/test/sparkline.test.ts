import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_THRESHOLD, SPARK_SAMPLES, Sparkline } from "../src/sparkline.js";

/** A sparkline preloaded with a rising load. */
function loaded(count: number, capacity?: number) {
  const spark = new Sparkline(capacity);
  for (let i = 0; i < count; i++) spark.push({ at: i * 1000, load: i + 1 });
  return spark;
}

test("an empty sparkline has nothing to draw", () => {
  const spark = new Sparkline();
  assert.equal(spark.hasSignal, false);
  assert.equal(spark.current, 0);
  assert.deepEqual(spark.points(20, 8), []);
  assert.equal(spark.summary(), "no activity yet");
});

test("samples are kept in the order they arrived", () => {
  const spark = loaded(3);
  assert.deepEqual(
    spark.history().map((sample) => sample.load),
    [1, 2, 3],
  );
});

test("the window is bounded so a long-running process does not grow", () => {
  // The tray runs for days. An unbounded history here would be a leak that no
  // short test could ever catch.
  const spark = new Sparkline(10);
  for (let i = 0; i < 1000; i++) spark.push({ at: i * 1000, load: i });
  assert.equal(spark.history().length, 10);
  assert.equal(spark.current, 999, "the newest sample must be the one kept");
});

test("the default capacity is what the tray expects", () => {
  const spark = new Sparkline();
  for (let i = 0; i < SPARK_SAMPLES + 20; i++) spark.push({ at: i, load: i });
  assert.equal(spark.history().length, SPARK_SAMPLES);
});

test("a negative load is recorded as none", () => {
  // Clamped to zero, and therefore not recorded at all.
  const spark = new Sparkline();
  spark.push({ at: 1, load: -5 });
  assert.equal(spark.current, 0);
  assert.equal(spark.hasSignal, false, "a negative load is not activity");
});

test("an idle reading leaves the trace untouched", () => {
  // Recording a zero would draw a bar for idleness, so a tray watching an agent
  // with nothing to do would look busy.
  const spark = new Sparkline();
  spark.push({ at: 1, load: 0 });
  assert.equal(spark.hasSignal, false);
  assert.deepEqual(spark.points(10, 4), []);
  spark.push({ at: 2, load: 2 });
  spark.push({ at: 3, load: 0 });
  assert.deepEqual(
    spark.history().map((sample) => sample.load),
    [2],
    "the idle reading must not have been appended",
  );
});

test("a load that is not a number cannot poison the scale", () => {
  // One NaN would make every comparison false and flatten the whole trace.
  const spark = loaded(3);
  spark.push({ at: 99_999, load: Number.NaN });
  assert.equal(spark.current, 3, "the bad reading is discarded, not stored");
  for (const point of spark.points(20, 8)) assert.ok(Number.isFinite(point.y));
});

test("an out-of-order sample is refused rather than drawn backwards", () => {
  // A backwards clock adjustment must not redraw the trace in reverse.
  const spark = loaded(3);
  spark.push({ at: 0, load: 99 });
  assert.deepEqual(
    spark.history().map((sample) => sample.load),
    [1, 2, 3],
  );
});

test("points span the box from left to right", () => {
  const points = loaded(3).points(11, 5);
  assert.equal(points.length, 3);
  assert.equal(points[0]?.x, 0);
  assert.equal(points.at(-1)?.x, 10);
});

test("a single sample sits at the left edge", () => {
  const spark = new Sparkline();
  spark.push({ at: 1, load: 1 });
  assert.equal(spark.points(20, 5)[0]?.x, 0);
});

test("the tallest sample reaches the top and a quiet one sits low", () => {
  const spark = new Sparkline();
  spark.push({ at: 2, load: 10 });
  spark.push({ at: 3, load: 5 });
  const points = spark.points(20, 11);
  assert.equal(points[0]?.y, 0, "the peak reaches the top");
  assert.equal(points[1]?.y, 5, "half the peak is halfway up");
});

test("the trace is scaled to its own peak, not an absolute scale", () => {
  // Otherwise a quiet period is a flat line pinned to the floor, which reads as
  // "nothing is happening" even when the relative shape is clearly busy.
  const spark = new Sparkline();
  spark.push({ at: 1, load: 1 });
  spark.push({ at: 2, load: 2 });
  const points = spark.points(20, 11);
  assert.equal(points[1]?.y, 0, "the peak of a quiet window still reaches the top");
  assert.ok((points[0]?.y ?? 0) > 0, "the quieter sample is still visibly lower");
});

test("an empty window draws nothing rather than dividing by zero", () => {
  // Zeros are never recorded, so the zero-peak branch is reached only when the
  // buffer is empty — and an empty buffer must produce no points at all.
  const spark = new Sparkline();
  for (let i = 0; i < 4; i++) spark.push({ at: i, load: 0 });
  assert.deepEqual(spark.points(20, 8), []);
});

test("a zero or negative box still produces drawable points", () => {
  const spark = loaded(2);
  for (const point of spark.points(0, 0)) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});

test("points are integers, because a fractional pixel is not a pixel", () => {
  for (const point of loaded(7).points(13, 9)) {
    assert.ok(Number.isInteger(point.x), `${point.x} is not an integer`);
    assert.ok(Number.isInteger(point.y), `${point.y} is not an integer`);
  }
});

test("the summary describes what the agent is doing", () => {
  // Idle is never recorded, so a sparkline with no work in it has genuinely seen
  // nothing — which is what "no activity yet" should say.
  const idle = new Sparkline();
  idle.push({ at: 1, load: 0 });
  assert.equal(idle.summary(), "no activity yet");

  const one = new Sparkline();
  one.push({ at: 1, load: 1 });
  assert.equal(one.summary(), "1 item in flight");

  const many = new Sparkline();
  many.push({ at: 1, load: 4 });
  assert.equal(many.summary(), "4 items in flight");
});

test("the busy threshold is a single outstanding item", () => {
  // One item is a reply in flight, not a backlog; the distinction is what keeps
  // the tray from looking alarmed during ordinary use.
  assert.equal(BUSY_THRESHOLD, 1);
});
