import assert from "node:assert/strict";
import { test } from "node:test";
import { intentionFor } from "../apps/server/src/engine/intention.ts";

test("every recognised tool produces its own distinct line", () => {
  // If two tools shared a line, a run using both would show the same text twice
  // and the person could not tell which step they were looking at.
  const names = [
    "search_web",
    "read_web",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_type",
    "browser_select",
    "browser_check",
    "browser_scroll",
    "browser_key",
    "browser_back",
    "browser_wait",
    "browser_tabs",
    "browser_upload",
    "inspect_pdf",
    "read_pdf",
    "fill_pdf",
    "prepare_email",
    "prepare_event",
    "search_mail",
    "read_mail_thread",
    "finish_task",
    "ask_user",
    "save_artifact",
  ];
  const lines = names.map((name) => intentionFor(name, {}));
  for (const [index, line] of lines.entries())
    assert.ok(line && line.length > 0, `${names[index]} produced no line`);
  assert.equal(new Set(lines).size, lines.length, "two tools share a line");
});

test("a search says what it is searching for", () => {
  assert.equal(
    intentionFor("search_web", { query: "flights to Lisbon in September" }),
    "🔍 Searching for “flights to Lisbon in September”",
  );
});

test("a page read names the site, not the whole URL", () => {
  // A full path with a tracking query is noise; the hostname is what a person
  // recognises as the page they asked about.
  assert.equal(
    intentionFor("read_web", { url: "https://www.example.com/flights/LIS?utm_source=x" }),
    "📄 Reading example.com",
  );
  assert.equal(
    intentionFor("read_web", { url: "http://sub.domain.co.uk/x" }),
    "📄 Reading sub.domain.co.uk",
  );
});

test("a missing or unusable argument still produces a line", () => {
  // A tool can be handed a URL that has not been normalised yet; the line must
  // still be there rather than the run showing nothing.
  assert.equal(intentionFor("read_web", {}), "📄 Reading a page");
  assert.equal(
    intentionFor("read_web", { url: "not a url at all" }),
    "📄 Reading not a url at all",
  );
  assert.equal(intentionFor("search_web", {}), "🔍 Searching the web");
  assert.equal(intentionFor("search_web", { query: "   " }), "🔍 Searching the web");
  assert.equal(intentionFor("read_web", null), "📄 Reading a page");
  assert.equal(intentionFor("read_web", "a string"), "📄 Reading a page");
});

test("a very long argument is cut rather than filling the row", () => {
  const long = "x".repeat(400);
  const line = intentionFor("search_web", { query: long });
  assert.ok(line && line.length < 120, `too long: ${line?.length}`);
  assert.ok(line?.includes("…"), "the cut must be visible");
});

test("whitespace in an argument is collapsed into one readable line", () => {
  assert.equal(
    intentionFor("search_web", { query: "  flights \n to\tLisbon  " }),
    "🔍 Searching for “flights to Lisbon”",
  );
});

test("an unknown tool yields nothing so the caller can fall back", () => {
  // Returning a wrong line is worse than returning nothing: the caller uses the
  // tool's own description, which is always accurate.
  assert.equal(
    intentionFor("some_tool_from_a_newer_release", { url: "https://x.example" }),
    undefined,
  );
  assert.equal(intentionFor("", {}), undefined);
});

test("an argument of the wrong type is ignored rather than rendered", () => {
  assert.equal(intentionFor("search_web", { query: { nested: "object" } }), "🔍 Searching the web");
  assert.equal(intentionFor("read_web", { url: 42 }), "📄 Reading a page");
  assert.equal(intentionFor("search_web", { query: ["a", "b"] }), "🔍 Searching the web");
});

test("no line contains a control character that would corrupt the log", () => {
  // A tool argument is untrusted text; a newline in it would break the one-line
  // format the accordion renders and could fake an extra step.
  const control = (value: string) => [...value].some((c) => c.charCodeAt(0) < 32);
  for (const args of [{ query: "a\nb" }, { url: "https://x.example/a\nb" }, { query: "a\tb" }]) {
    const line = intentionFor("search_web", args) ?? intentionFor("read_web", args) ?? "";
    assert.ok(!control(line), `a control character survived: ${JSON.stringify(line)}`);
  }
});

test("a hostname longer than the display limit is cut", () => {
  const long = `${"a".repeat(200)}.example`;
  const line = intentionFor("read_web", { url: `https://${long}/x` });
  assert.ok(line && line.length < 100, `too long: ${line?.length}`);
});
