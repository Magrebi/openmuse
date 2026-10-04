import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseContext,
  countKind,
  type DiffLine,
  describeDiff,
  diffText,
  keyRows,
  MAX_LINES,
} from "../src/diff.ts";

/** The diff as a compact string, so assertions read like the thing itself. */
const shape = (before: string, after: string) =>
  diffText(before, after)
    .lines.map((line) => `${line.kind[0]}:${line.text}`)
    .join("|");

test("identical texts have no changes", () => {
  const diff = diffText("a\nb\nc", "a\nb\nc");
  assert.equal(diff.changed, 0);
  assert.equal(countKind(diff.lines, "same"), 3);
  assert.equal(describeDiff(diff), "Unchanged");
});

test("a changed line is shown as one removal and one addition", () => {
  assert.equal(shape("a\nb\nc", "a\nX\nc"), "s:a|r:b|a:X|s:c");
  assert.equal(diffText("a\nb\nc", "a\nX\nc").changed, 2);
});

test("an added line is not paired with an unrelated removal", () => {
  // The interesting case: a whole paragraph inserted between two kept lines must
  // not be reported as one removal plus one addition, which would read as
  // "this line was rewritten" when nothing was rewritten.
  const diff = diffText("a\nc", "a\nb1\nb2\nc");
  assert.deepEqual(diff.lines, [
    { kind: "same", text: "a" },
    { kind: "added", text: "b1" },
    { kind: "added", text: "b2" },
    { kind: "same", text: "c" },
  ]);
});

test("text added at the very end is all additions", () => {
  assert.equal(shape("a", "a\nb\nc"), "s:a|a:b|a:c");
});

test("text removed from the very end is all removals", () => {
  assert.equal(shape("a\nb\nc", "a"), "s:a|r:b|r:c");
});

test("a trailing newline does not create a phantom line", () => {
  // Every email ends with a newline. If that counted, every edit would report a
  // spurious change on the last line.
  assert.equal(diffText("a\nb\n", "a\nb\n").changed, 0);
  assert.equal(diffText("a\nb", "a\nb\n").changed, 0);
});

test("empty texts are handled on both sides", () => {
  assert.equal(shape("", "new"), "a:new");
  assert.equal(shape("old", ""), "r:old");
  assert.equal(diffText("", "").changed, 0);
  assert.deepEqual(diffText("", "").lines, []);
});

test("a blank line in the middle is a real line", () => {
  assert.equal(diffText("a\n\nb", "a\n\nb").changed, 0);
  assert.equal(diffText("a\n\nb", "a\nb").changed, 1, "only the blank line changed");
});

test("changed counts lines, not characters", () => {
  const diff = diffText("one\ntwo\nthree", "ONE\ntwo\nthree");
  assert.equal(diff.changed, 2);
  assert.equal(describeDiff(diff), "2 lines changed");
});

test("one change is described in the singular", () => {
  const diff = diffText("a\nb", "a\nb\nc");
  assert.equal(describeDiff(diff), "1 line changed");
});

test("text too long to compare says so instead of truncating quietly", () => {
  const long = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
  const diff = diffText(long, `${long}\nextra`);
  assert.equal(diff.truncated, true);
  assert.equal(describeDiff(diff), "Too long to compare line by line");
  assert.ok(diff.lines.length > 0, "the current text is still shown");
});

test("text at exactly the limit is still compared", () => {
  const atLimit = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join("\n");
  assert.equal(diffText(atLimit, atLimit).truncated, false);
});

test("a long text is compared in a reasonable time", () => {
  // The O(n·m) table is the whole reason `MAX_LINES` exists; this is the guard
  // that stops someone raising it later without noticing the cost.
  const a = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join("\n");
  const b = a.replace("line 200", "line 200 edited");
  const started = Date.now();
  const diff = diffText(a, b);
  assert.equal(diff.changed, 2);
  assert.ok(Date.now() - started < 500, "the diff took too long to run on the UI thread");
});

test("unchanged stretches collapse to a gap", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 10", "line 10 edited");
  const rows = collapseContext(diffText(before, after).lines, 2);
  const gaps = rows.filter((row) => row.kind === "gap");
  // Two stretches: the untouched run above the change and the one below it.
  assert.equal(gaps.length, 2);
  // Every changed line survives; only the far context is dropped.
  assert.ok(rows.some((row) => row.kind === "added" && row.text === "line 10 edited"));
  assert.ok(rows.some((row) => row.kind === "removed" && row.text === "line 10"));
});

test("collapse never hides a change", () => {
  // The invariant that matters: collapsing is a readability feature, so it must
  // not be able to hide the one thing the reviewer opened the card to see.
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1", "changed early").replace("line 28", "changed late");
  const rows = collapseContext(diffText(before, after).lines, 2);
  for (const text of ["changed early", "changed late"]) {
    assert.ok(
      rows.some((row) => row.kind !== "gap" && row.text === text),
      `${text} was hidden by collapsing`,
    );
  }
});

test("collapse leaves an entirely changed text alone", () => {
  const rows = collapseContext(diffText("a\nb", "x\ny").lines, 2);
  assert.ok(
    rows.every((row) => row.kind !== "gap"),
    "nothing here should collapse",
  );
});

test("collapse leaves unchanged text alone", () => {
  // Everything is context when nothing changed, so nothing may be dropped.
  const rows = collapseContext(diffText("a\nb\nc", "a\nb\nc").lines, 2);
  assert.equal(rows.filter((row) => row.kind === "gap").length, 0);
  assert.equal(rows.length, 3);
});

test("a gap reports how many lines it stands for", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 0", "edited");
  const rows = collapseContext(diffText(before, after).lines, 1);
  const gap = rows.find((row) => row.kind === "gap");
  assert.ok(gap && gap.kind === "gap");
  // Thirteen rows in all: the removal, the addition and eleven untouched lines.
  // One line of context either side of the change keeps three of them.
  assert.equal(gap.count, 10);
});

test("keys are unique when rows repeat", () => {
  // Three identical lines are three rendered rows. Sharing a key would make
  // React drop two of them, so a letter with three "Thanks" lines would lose two.
  const rows: DiffLine[] = [
    { kind: "same", text: "Thanks" },
    { kind: "same", text: "Thanks" },
    { kind: "same", text: "Thanks" },
  ];
  const keys = keyRows(rows);
  assert.equal(new Set(keys).size, 3);
});

test("a line that changed gets a different key than the line it replaced", () => {
  // The property the animation depends on: a row is identified by what it says,
  // so editing a line makes it a new row rather than the old row moving.
  const before = keyRows([{ kind: "same", text: "See you Tuesday" }]);
  const after = keyRows([{ kind: "same", text: "See you Thursday" }]);
  assert.notEqual(before[0], after[0]);
});

test("an unchanged row keeps its key when a line is added above it", () => {
  // The bug an index key would have: everything below an insertion keeps its
  // index, so the animation slides the wrong text into the wrong row.
  const before = keyRows([{ kind: "same", text: "Body" }]);
  const after = keyRows([
    { kind: "added", text: "New opening" },
    { kind: "same", text: "Body" },
  ]);
  assert.equal(before[0], after[1], "the untouched line must keep its identity");
});

test("identical rows keep their identity when the diff is recomputed", () => {
  const rows: DiffLine[] = [
    { kind: "same", text: "a" },
    { kind: "removed", text: "b" },
    { kind: "added", text: "c" },
  ];
  assert.deepEqual(keyRows(rows), keyRows(rows));
});

test("rows and gaps are keyed apart", () => {
  const keys = keyRows([
    { kind: "gap", count: 3 },
    { kind: "same", text: "x" },
    { kind: "gap", count: 3 },
  ]);
  assert.equal(new Set(keys).size, 3, "two gaps of the same size are still two rows");
});
