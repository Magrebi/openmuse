/**
 * Showing what changed, line by line.
 *
 * The review card exists to answer one question: is this what I expected? For a
 * message the agent drafted, that is hard to answer by reading the new text
 * alone, because you cannot tell what was kept from what was invented. A diff
 * answers it directly, and answers it against the only baseline that means
 * anything: the agent's own draft.
 *
 * This is a line-level LCS diff rather than a word-level one because the unit a
 * person reviews an email in is the line. It is also O(n·m) in the two lengths,
 * which is why `MAX_LINES` exists: this runs against every keystroke of an
 * in-progress edit, and a pasted novel would otherwise be quadratic on the UI
 * thread.
 *
 * Pure and dependency-free so the behaviour can be tested without a renderer.
 */

/** Beyond this, the texts are not compared line by line. */
export const MAX_LINES = 400;

/** What one line did. */
export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** A collapsed run of untouched lines. */
export interface DiffGap {
  kind: "gap";
  count: number;
}

/** The whole comparison, plus what could not be shown. */
export interface Diff {
  lines: DiffLine[];
  /** True when either side was too long to compare line by line. */
  truncated: boolean;
  /** How many lines differ, ignoring where they moved. */
  changed: number;
}

/**
 * Split into lines, dropping a trailing newline so a text that ends with one
 * does not gain a phantom empty line at the end of the diff.
 */
function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * Compare two texts.
 *
 * `before` is the agent's draft and `after` is what will actually be sent, so a
 * `removed` line is something the agent wrote that the reviewer struck, and an
 * `added` line is something the reviewer introduced.
 */
export function diffText(before: string, after: string): Diff {
  const a = lines(before);
  const b = lines(after);
  // Too long to compare honestly, and a diff that silently truncated would be
  // worse than one that admits it did not try.
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      truncated: true,
      changed: Math.max(a.length, b.length),
      lines: [{ kind: "same", text: after }],
    };
  }

  // Longest common subsequence, then walk it back into per-line operations.
  // `width` is one longer than `a` so the sentinel column is always addressable.
  const width = b.length + 1;
  const table: number[] = new Array((a.length + 1) * width).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let changed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      out.push({ kind: "removed", text: a[i++] });
      changed++;
    } else {
      out.push({ kind: "added", text: b[j++] });
      changed++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i++] });
    changed++;
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j++] });
    changed++;
  }
  return { lines: out, truncated: false, changed };
}

/** How many lines carry the given mark. */
export function countKind(lines: DiffLine[], kind: DiffKind): number {
  let n = 0;
  for (const line of lines) if (line.kind === kind) n++;
  return n;
}

/**
 * Hide long unchanged runs.
 *
 * A diff showing twenty identical lines around a one-word change is harder to
 * read than the change itself, so untouched stretches collapse to a marker.
 * Changed lines are never dropped — only context around them.
 */
export function collapseContext(lines: DiffLine[], context = 2): (DiffLine | DiffGap)[] {
  // Nothing changed, so there is nothing to anchor context to and every line
  // would collapse. That would hide the entire body behind a "3 unchanged
  // lines" marker — the worst possible outcome on the one card whose job is to
  // show somebody what they are about to send.
  if (!lines.some((line) => line.kind !== "same")) return lines;
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });
  const out: (DiffLine | DiffGap)[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (gap > 0) {
        out.push({ kind: "gap", count: gap });
        gap = 0;
      }
      out.push(line);
    } else gap++;
  });
  if (gap > 0) out.push({ kind: "gap", count: gap });
  return out;
}

/**
 * Give every rendered row a key that is stable across re-diffs.
 *
 * The rendered list is animated, and an animation identifies rows by key. Keying
 * by array position means that when a line is inserted near the top, every row
 * below it keeps its index and its key, so the animation slides the wrong text
 * into the wrong place — a diff that visibly lies about what changed. Keying by
 * content means a row whose text changed is a genuinely different row, which is
 * what it is.
 *
 * Duplicates are disambiguated by counting occurrences, because a letter with
 * three identical "Thanks" lines is three rows, not one. The count is taken in
 * order, so which one keeps which key is decided by position — unavoidable when
 * the rows are identical, and harmless because they render identically.
 */
export function keyRows(rows: (DiffLine | DiffGap)[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const identity = row.kind === "gap" ? `gap-${row.count}` : `${row.kind}:${row.text}`;
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    return `${identity}#${nth}`;
  });
}

/** One phrase, for the card's heading. */
export function describeDiff(diff: Diff): string {
  if (diff.truncated) return "Too long to compare line by line";
  if (diff.changed === 0) return "Unchanged";
  return diff.changed === 1 ? "1 line changed" : `${diff.changed} lines changed`;
}
