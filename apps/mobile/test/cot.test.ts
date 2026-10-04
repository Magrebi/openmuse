import assert from "node:assert/strict";
import { test } from "node:test";
import { accordionHeight, type CotEvent, headline, summarise, toCotSteps } from "../src/cot.ts";

function event(over: Partial<CotEvent> = {}): CotEvent {
  return {
    id: "e1",
    date: "2026-03-08T10:00:00.000Z",
    kind: "step",
    title: "Searched the web",
    detail: "",
    ...over,
  };
}

test("the newest step is the current one, and older steps are not", () => {
  const steps = toCotSteps([
    event({ id: "a", date: "2026-03-08T10:00:00.000Z" }),
    event({ id: "b", date: "2026-03-08T10:01:00.000Z", title: "Read a page" }),
    event({ id: "c", date: "2026-03-08T10:02:00.000Z", title: "Drafted a reply" }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.headline),
    ["Drafted a reply", "Read a page", "Searched the web"],
  );
  assert.equal(steps[0].current, true);
  assert.equal(steps.filter((s) => s.current).length, 1, "exactly one row is current");
});

test("events are ordered by their own timestamp, not by the order they arrived", () => {
  // A run whose events were written in one transaction can come back out of
  // order; rendering them as they arrived would show the steps backwards.
  const steps = toCotSteps([
    event({ id: "late", date: "2026-03-08T10:05:00.000Z", title: "Third" }),
    event({ id: "early", date: "2026-03-08T10:00:00.000Z", title: "First" }),
    event({ id: "mid", date: "2026-03-08T10:02:00.000Z", title: "Second" }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.headline),
    ["Third", "Second", "First"],
  );
});

test("a repeated identical step collapses to one row", () => {
  // The agent records a step before and a result after each tool call, so a
  // naive render duplicates every action.
  const steps = toCotSteps([
    event({ id: "a", date: "2026-03-08T10:00:00.000Z", title: "Checked the page" }),
    event({ id: "b", date: "2026-03-08T10:01:00.000Z", title: "Checked the page" }),
    event({ id: "c", date: "2026-03-08T10:02:00.000Z", title: "Checked the page" }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, "a", "the earliest row's identity is kept");
  assert.equal(steps[0].at, "2026-03-08T10:02:00.000Z", "but the latest timestamp is");
});

test("two identical steps separated by something else are both kept", () => {
  // Merging them would silently delete a real step from the record.
  const steps = toCotSteps([
    event({ id: "a", date: "2026-03-08T10:00:00.000Z", title: "Checked the page" }),
    event({ id: "b", date: "2026-03-08T10:01:00.000Z", title: "Read the result" }),
    event({ id: "c", date: "2026-03-08T10:02:00.000Z", title: "Checked the page" }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.headline),
    ["Checked the page", "Read the result", "Checked the page"],
  );
});

test("collapsing keeps whichever occurrence carried a detail", () => {
  const steps = toCotSteps([
    event({ id: "a", date: "2026-03-08T10:00:00.000Z", detail: "" }),
    event({ id: "b", date: "2026-03-08T10:01:00.000Z", detail: "the full page text" }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].detail, "the full page text", "detail must not be lost by collapsing");
});

test("a step with no title still gets a row, from its detail", () => {
  const steps = toCotSteps([event({ id: "a", title: "", detail: "browser_click on e4" })]);
  assert.equal(steps[0].headline, "browser_click on e4");
});

test("an event with neither title nor detail still renders something", () => {
  const steps = toCotSteps([event({ id: "a", title: "", detail: "" })]);
  assert.ok(steps[0].headline.length > 0);
});

test("an error or an approval is flagged as needing the person", () => {
  // Distinct timestamps: rows are ordered by time, so three events sharing one
  // would be listed in an arbitrary order and the assertions meaningless.
  const steps = toCotSteps([
    event({ id: "s", date: "2026-03-08T10:00:00.000Z", kind: "step", title: "Still working" }),
    event({
      id: "a",
      date: "2026-03-08T10:01:00.000Z",
      kind: "approval",
      title: "Waiting for your review",
    }),
    event({
      id: "e",
      date: "2026-03-08T10:02:00.000Z",
      kind: "error",
      title: "The page refused to load",
    }),
  ]);
  assert.equal(steps.length, 3);
  assert.ok(steps[0].needsAttention, "an error must be flagged");
  assert.ok(steps[1].needsAttention, "an approval must be flagged");
  assert.equal(steps[2].needsAttention, false);
});

test("the summary leads with whatever needs the person, not merely what is newest", () => {
  // While a task is running the newest step is usually "still working"; the
  // thing the person is actually waiting on is the blocked one.
  const steps = toCotSteps([
    event({ id: "e", kind: "error", title: "Could not reach the airline" }),
    event({ id: "s", kind: "step", title: "Still working" }),
  ]);
  assert.equal(summarise(steps), "Could not reach the airline");
  assert.equal(summarise([]), "");
});

test("the summary falls back to the newest step when nothing needs attention", () => {
  const steps = toCotSteps([event({ id: "a", title: "Drafted a reply" })]);
  assert.equal(summarise(steps), "Drafted a reply");
});

test("a long line is cut at a word, never mid-word", () => {
  const long =
    "Searching every airline website for a departure that leaves after the meeting ends tomorrow morning";
  assert.ok(long.length > 92, "the fixture must actually exceed the limit");
  const cut = headline(long);
  assert.ok(cut.length <= 92, `too long: ${cut.length}`);
  assert.ok(cut.endsWith("…"), `no ellipsis: "${cut}"`);
  // The character before the ellipsis must be a letter, not half of one.
  assert.match(cut.slice(0, -1), /[a-z]$/i, `ended mid-word: "${cut}"`);
  assert.ok(!/\s…$/.test(cut), "a trailing space before the ellipsis looks broken");
});

test("a short line is left exactly as written", () => {
  assert.equal(headline("Searched the web"), "Searched the web");
  assert.equal(headline("  spaced   out  "), "spaced out", "runs of whitespace collapse");
});

test("a headline with no word boundary near the limit is cut hard rather than emptied", () => {
  const unbroken = "x".repeat(300);
  const cut = headline(unbroken);
  assert.equal(cut.length, 92);
  assert.ok(cut.endsWith("…"));
});

test("a long log is bounded, so opening a task does not get slower as it ages", () => {
  // A monitor that has run for a month has thousands of events.
  const many = Array.from({ length: 5000 }, (_, i) =>
    event({
      id: `e${i}`,
      date: new Date(Date.UTC(2026, 2, 8, 0, 0, i)).toISOString(),
      title: `Checked for a change ${i}`,
    }),
  );
  const steps = toCotSteps(many);
  assert.equal(steps.length, 24);
  assert.equal(steps[0].headline, headline("Checked for a change 4999"), "keeps the newest");
});

test("a zero or negative bound produces no rows rather than throwing", () => {
  assert.deepEqual(toCotSteps([event()], 0), []);
  assert.deepEqual(toCotSteps([event()], -5), []);
});

test("an empty log produces no rows and no summary", () => {
  assert.deepEqual(toCotSteps([]), []);
  assert.equal(summarise(toCotSteps([])), "");
});

test("a collapsed row is exactly one line tall, never zero", () => {
  // A zero-height row disappears, which reads as the list losing an entry.
  assert.equal(accordionHeight(false, 400, 44), 44);
  assert.equal(accordionHeight(false, 0, 0), 0);
});

test("an expanded row grows to its content but is never shorter than one line", () => {
  assert.equal(accordionHeight(true, 400, 44), 400);
  assert.equal(accordionHeight(true, 10, 44), 44, "short detail must not shrink the row");
});

test("a broken measurement cannot produce a negative or NaN height", () => {
  for (const [content, row] of [
    [Number.NaN, 44],
    [Number.POSITIVE_INFINITY, 44],
    [-100, 44],
    [400, Number.NaN],
  ]) {
    const height = accordionHeight(true, content, row);
    assert.ok(Number.isFinite(height) && height >= 0, `${content}/${row} -> ${height}`);
  }
});

test("every step carries a colour and an icon, whatever its kind", () => {
  const kinds = ["plan", "step", "observation", "approval", "result", "error", "status"] as const;
  for (const kind of kinds) {
    const steps = toCotSteps([event({ id: kind, kind })]);
    assert.match(steps[0].tint, /^#[0-9A-Fa-f]{6}$/, kind);
    assert.ok(steps[0].icon.length > 0, kind);
  }
});

test("an unrecognised kind falls back rather than crashing the accordion", () => {
  const steps = toCotSteps([event({ id: "x", kind: "invented" as never })]);
  assert.equal(steps.length, 1);
  assert.match(steps[0].tint, /^#/);
});
