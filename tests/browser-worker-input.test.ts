import assert from "node:assert/strict";
import test from "node:test";
import { UNSUPPORTED_INPUT_MESSAGE } from "../apps/server/src/engine/browser-input.ts";
import {
  INPUT_KEYS,
  MAX_DELAY,
  MAX_INPUT_TEXT,
  MAX_SCROLL,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  validateInput,
} from "../apps/worker/src/browser.ts";
import { unwrapResultHref } from "../apps/worker/src/extract.ts";

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

test("element refs are accepted only in the shape a snapshot issues", () => {
  assert.deepEqual(validateInput({ type: "activate", ref: "e1" }), {
    type: "activate",
    ref: "e1",
  });
  assert.deepEqual(validateInput({ type: "fill", ref: "e12", text: "usb-c" }), {
    type: "fill",
    ref: "e12",
    text: "usb-c",
  });
  assert.deepEqual(validateInput({ type: "select", ref: "e3", value: "Sort: price" }), {
    type: "select",
    ref: "e3",
    value: "Sort: price",
  });
  assert.deepEqual(validateInput({ type: "check", ref: "e4", checked: false }), {
    type: "check",
    ref: "e4",
    checked: false,
  });
  for (const ref of [
    "",
    "e",
    "e0",
    "e01",
    "e1000",
    "E1",
    " e1",
    "e1 ",
    "e1; drop",
    "a1",
    "#e1",
    "[data-openmuse-ref=e1]",
    1,
    null,
    undefined,
    { ref: "e1" },
  ])
    assert.throws(
      () => validateInput({ type: "activate", ref }),
      { code: "INVALID_INPUT" },
      `must reject ref ${JSON.stringify(ref)}`,
    );
  // A ref cannot be dropped to smuggle a second action into the same payload.
  assert.deepEqual(
    validateInput({ type: "fill", ref: "e2", text: "hi", checked: true, deltaY: 900 }),
    { type: "fill", ref: "e2", text: "hi" },
  );
});

test("fill and select are bounded like typed text", () => {
  assert.deepEqual(validateInput({ type: "fill", ref: "e1", text: "a".repeat(MAX_INPUT_TEXT) }), {
    type: "fill",
    ref: "e1",
    text: "a".repeat(MAX_INPUT_TEXT),
  });
  assert.throws(
    () => validateInput({ type: "fill", ref: "e1", text: "a".repeat(MAX_INPUT_TEXT + 1) }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => validateInput({ type: "fill", ref: "e1", text: "" }), {
    code: "INVALID_INPUT",
  });
  assert.throws(
    () => validateInput({ type: "select", ref: "e1", value: "a".repeat(MAX_INPUT_TEXT + 1) }),
    { code: "INVALID_INPUT" },
  );
  // `checked` is required to be a real boolean: an omitted one must not mean "false".
  assert.throws(() => validateInput({ type: "check", ref: "e1" }), { code: "INVALID_INPUT" });
  assert.throws(() => validateInput({ type: "check", ref: "e1", checked: "yes" }), {
    code: "INVALID_INPUT",
  });
});

test("history moves are fixed verbs and take no address", () => {
  for (const to of ["back", "forward", "reload"])
    assert.deepEqual(validateInput({ type: "nav", to }), { type: "nav", to }, to);
  for (const to of ["https://evil.example", "", "back; forward", "goto", 42, null])
    assert.throws(
      () => validateInput({ type: "nav", to }),
      { code: "INVALID_INPUT" },
      `must reject nav to ${JSON.stringify(to)}`,
    );
});

test("a wrapped search result is unwrapped to the destination it points at", () => {
  const target = "https://www.rfc-editor.org/rfc/rfc9110.txt";
  assert.equal(
    unwrapResultHref(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=deadbeef`),
    target,
  );
  assert.equal(unwrapResultHref(`//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`), target);
  assert.equal(
    unwrapResultHref(`https://example.com/direct?q=${encodeURIComponent(target)}`),
    `https://example.com/direct?q=${encodeURIComponent(target)}`,
  );
  // Anything that is not a public web address is dropped rather than handed on as a
  // destination the agent might open.
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<b>hi</b>",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "not a url",
    "",
    "https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)",
  ])
    assert.equal(unwrapResultHref(value), undefined, JSON.stringify(value));
});

test("a wait takes only the parameters its verb understands", () => {
  assert.deepEqual(validateInput({ type: "wait", until: "idle" }), {
    type: "wait",
    until: "idle",
  });
  assert.deepEqual(validateInput({ type: "wait", until: "text" }), {
    type: "wait",
    until: "text",
  });
  assert.deepEqual(validateInput({ type: "wait", until: "element", ref: "e2" }), {
    type: "wait",
    until: "element",
  });
  assert.deepEqual(validateInput({ type: "wait", until: "delay", ms: 250 }), {
    type: "wait",
    until: "delay",
    ms: 250,
  });
  assert.deepEqual(validateInput({ type: "wait", until: "delay", ms: 0 }), {
    type: "wait",
    until: "delay",
    ms: 0,
  });
  // `element` without a ref has nothing to wait for.
  assert.throws(() => validateInput({ type: "wait", until: "element" }), {
    code: "INVALID_INPUT",
  });
  // A delay is bounded so a wait cannot stall a task run.
  assert.throws(() => validateInput({ type: "wait", until: "delay", ms: MAX_DELAY + 1 }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "wait", until: "delay", ms: -1 }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "wait", until: "delay", ms: Number.NaN }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => validateInput({ type: "wait", until: "delay" }), {
    code: "INVALID_INPUT",
  });
  for (const until of ["selector", "selector:div", "networkidle", "", 42, undefined])
    assert.throws(
      () => validateInput({ type: "wait", until }),
      { code: "INVALID_INPUT" },
      `must reject until ${JSON.stringify(until)}`,
    );
});

test("an upload names a plain file and never carries a path", () => {
  assert.deepEqual(validateInput({ type: "upload", ref: "e5", file: "invoice.pdf" }), {
    type: "upload",
    ref: "e5",
    file: "invoice.pdf",
  });
  assert.deepEqual(validateInput({ type: "upload", ref: "e5", file: "Tax Return 2026.pdf" }), {
    type: "upload",
    ref: "e5",
    file: "Tax Return 2026.pdf",
  });
  for (const file of [
    "",
    "../secret.pdf",
    "..",
    "../../etc/passwd",
    "/etc/passwd",
    "dir/file.pdf",
    "dir\\file.pdf",
    "~/notes.pdf",
    "file.pdf\x00.txt",
    "noextension",
    "a".repeat(200),
    42,
    null,
    undefined,
  ])
    assert.throws(
      () => validateInput({ type: "upload", ref: "e5", file }),
      { code: "INVALID_INPUT" },
      `must reject file ${JSON.stringify(file)}`,
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
