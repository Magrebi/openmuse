import assert from "node:assert/strict";
import test from "node:test";
import { UNSUPPORTED_INPUT_MESSAGE } from "../apps/server/src/engine/browser-input.ts";
import {
  INPUT_KEYS,
  MAX_INPUT_TEXT,
  MAX_SCROLL,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  validateInput,
} from "../apps/worker/src/browser.ts";

test("the server rejects with the same wording the worker would return", () => {
  // The server validates before calling the worker so the takeover console never shows a
  // raw schema error. If the worker ever changes its message, this fails rather than
  // letting the two paths drift into different text for the same mistake.
  assert.throws(() => validateInput({ type: "click", x: SCREEN_WIDTH, y: 0 }), {
    code: "INVALID_INPUT",
    message: UNSUPPORTED_INPUT_MESSAGE,
  });
});

test("clicks are confined to the 1280x800 screenshot the worker returns", () => {
  assert.deepEqual(validateInput({ type: "click", x: 0, y: 0 }), {
    type: "click",
    x: 0,
    y: 0,
  });
  assert.deepEqual(validateInput({ type: "click", x: SCREEN_WIDTH - 1, y: SCREEN_HEIGHT - 1 }), {
    type: "click",
    x: SCREEN_WIDTH - 1,
    y: SCREEN_HEIGHT - 1,
  });
  for (const value of [
    { type: "click", x: SCREEN_WIDTH, y: 0 },
    { type: "click", x: 0, y: SCREEN_HEIGHT },
    { type: "click", x: -1, y: 0 },
    { type: "click", x: 0, y: -1 },
    { type: "click", x: Number.NaN, y: 0 },
    { type: "click", x: Number.POSITIVE_INFINITY, y: 0 },
    { type: "click", x: "10", y: 10 },
    { type: "click", y: 10 },
  ])
    assert.throws(
      () => validateInput(value),
      { code: "INVALID_INPUT" },
      `must reject ${JSON.stringify(value)}`,
    );
});

test("typed text is bounded and scroll stays on one axis within range", () => {
  assert.deepEqual(validateInput({ type: "text", text: "hello" }), {
    type: "text",
    text: "hello",
  });
  assert.deepEqual(validateInput({ type: "text", text: "a".repeat(MAX_INPUT_TEXT) }).type, "text");
  assert.throws(() => validateInput({ type: "text", text: "a".repeat(MAX_INPUT_TEXT + 1) }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "text", text: "" }), { code: "INVALID_INPUT" });
  assert.throws(() => validateInput({ type: "text", text: 42 }), { code: "INVALID_INPUT" });
  assert.throws(() => validateInput({ type: "scroll", deltaY: MAX_SCROLL + 1 }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "scroll", deltaY: -MAX_SCROLL - 1 }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "scroll", deltaY: Number.NaN }), {
    code: "INVALID_INPUT",
  });
  // The worker only ever reads deltaY, so an extra axis is ignored rather than acted on.
  assert.deepEqual(validateInput({ type: "scroll", deltaY: 100, deltaX: 400 }), {
    type: "scroll",
    deltaY: 100,
  });
});

test("only whitelisted navigation keys reach the page keyboard", () => {
  for (const key of INPUT_KEYS)
    assert.deepEqual(validateInput({ type: "key", key }), { type: "key", key }, key);
  for (const key of ["F5", "F12", "Enter\n", "control+a", "Cmd+a", "Alt+F4", " ", "Backspace "])
    assert.throws(
      () => validateInput({ type: "key", key }),
      { code: "INVALID_INPUT" },
      `must reject key ${JSON.stringify(key)}`,
    );
});

test("an unknown action cannot smuggle extra behaviour into the page", () => {
  for (const value of [
    { type: "navigate", url: "https://example.com" },
    { type: "evaluate", script: "fetch('https://example.com')" },
    { type: "download" },
    {},
    { type: 42 },
  ])
    assert.throws(() => validateInput(value), { code: "INVALID_INPUT" }, JSON.stringify(value));
});
