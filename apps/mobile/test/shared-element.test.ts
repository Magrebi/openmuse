import assert from "node:assert/strict";
import { test } from "node:test";
import {
  frameFromSource,
  interpolateFrame,
  isUsableRect,
  type Rect,
  restFrame,
  settledFrame,
  startFrame,
} from "../src/shared-element.ts";

/** A card in the middle of a phone screen. */
const CARD: Rect = { x: 20, y: 300, width: 350, height: 140 };
/** The sheet it opens into. */
const PANEL: Rect = { x: 12, y: 60, width: 366, height: 700 };
const WINDOW: Rect = { x: 0, y: 0, width: 390, height: 844 };

test("the panel starts exactly where the card was, not near it", () => {
  const frame = frameFromSource(CARD, PANEL);
  // React Native applies `translate` then `scale`, and a scale is taken about
  // the view's own centre, so a transform moves the panel's centre by exactly
  // the translate and leaves that centre alone. Landing the centre on the
  // card's centre therefore lands the panel exactly on the card.
  const panelCenterX = PANEL.x + PANEL.width / 2;
  const panelCenterY = PANEL.y + PANEL.height / 2;
  assert.equal(panelCenterX + frame.translateX, CARD.x + CARD.width / 2);
  assert.equal(panelCenterY + frame.translateY, CARD.y + CARD.height / 2);
});

test("the panel opens at the card's size, never larger than it", () => {
  const frame = frameFromSource(CARD, PANEL);
  assert.ok(Math.abs(frame.scaleX - CARD.width / PANEL.width) < 1e-9);
  assert.ok(Math.abs(frame.scaleY - CARD.height / PANEL.height) < 1e-9);
  assert.ok(frame.scaleX <= 1, "a card wider than the sheet must not make it bulge");
  assert.ok(frame.scaleY <= 1);
});

test("the card is opaque, so the panel does not fade in over a doubled image", () => {
  assert.equal(frameFromSource(CARD, PANEL).opacity, 1);
});

test("a card already the size of the sheet produces no movement at all", () => {
  const frame = frameFromSource(PANEL, PANEL);
  assert.deepEqual(frame, settledFrame());
});

test("a transition reaches its settled frame exactly at full progress", () => {
  const from = frameFromSource(CARD, PANEL);
  const to = settledFrame();
  assert.deepEqual(interpolateFrame(from, to, 0), from);
  assert.deepEqual(interpolateFrame(from, to, 1), to);
});

test("progress outside 0..1 is clamped rather than extrapolating the panel away", () => {
  const from = frameFromSource(CARD, PANEL);
  assert.deepEqual(interpolateFrame(from, settledFrame(), -5), from);
  assert.deepEqual(interpolateFrame(from, settledFrame(), 5), settledFrame());
  assert.deepEqual(interpolateFrame(from, settledFrame(), Number.NaN), from);
});

test("an unmeasured source falls back to a plain fade instead of jumping", () => {
  for (const source of [null, undefined, { ...CARD, width: 0 }, { ...CARD, height: -5 }]) {
    assert.deepEqual(startFrame(source, PANEL, WINDOW), restFrame());
  }
});

test("a non-finite measurement is rejected rather than animated", () => {
  for (const source of [
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
    { x: 0, y: 0, width: Number.NaN, height: 10 },
  ]) {
    assert.equal(isUsableRect(source), false);
    assert.deepEqual(startFrame(source, PANEL), restFrame());
  }
});

test("a measurement from a surface that no longer exists is rejected", () => {
  const stale = { x: 400_000, y: -400_000, width: 350, height: 140 };
  assert.equal(isUsableRect(stale, WINDOW), false, "far outside the window");
  assert.deepEqual(startFrame(stale, PANEL, WINDOW), restFrame());
});

test("a card scrolled partly off screen is still a valid source", () => {
  // A negative y is normal in a scrolling list and must not be mistaken for a
  // stale measurement, or every card below the fold would lose its transition.
  const scrolled = { x: 20, y: -200, width: 350, height: 140 };
  assert.equal(isUsableRect(scrolled, WINDOW), true);
  assert.notDeepEqual(startFrame(scrolled, PANEL, WINDOW), restFrame());
});

test("a degenerate panel does not divide by zero and produce Infinity", () => {
  const frame = frameFromSource(CARD, { x: 0, y: 0, width: 0, height: 0 });
  for (const value of Object.values(frame)) assert.ok(Number.isFinite(value), `${value}`);
});

test("every frame a caller could receive is finite and renderable", () => {
  const sources: (Rect | null)[] = [
    null,
    CARD,
    { x: -1e6, y: -1e6, width: 10, height: 10 },
    { x: 0, y: 0, width: 1e9, height: 1e9 },
    { x: 1e12, y: 1e12, width: 5, height: 5 },
  ];
  for (const source of sources) {
    for (const progress of [0, 0.25, 0.5, 1, -1, 2, Number.NaN]) {
      const frame = interpolateFrame(startFrame(source, PANEL, WINDOW), settledFrame(), progress);
      for (const [key, value] of Object.entries(frame))
        assert.ok(Number.isFinite(value), `${key}=${value} for ${JSON.stringify(source)}`);
      assert.ok(frame.opacity >= 0 && frame.opacity <= 1, "opacity out of range");
    }
  }
});
