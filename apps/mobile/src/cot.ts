/**
 * The granular chain-of-thought accordion.
 *
 * The agent's run events are a flat, chronological log: "Searched the web",
 * "Read a page", "Prepared a reply". That is an audit trail, not an explanation.
 * What a person wants while it works is a live sense of *what it is doing right
 * now and why*, which is a different shape: a short list of micro-intentions,
 * the newest one emphasised, with the detail one tap away.
 *
 * This module owns that reshaping. It is pure, because the rules that decide
 * what to show, what to collapse and what to drop are the part that goes wrong:
 * a log that grows without bound, an accordion that flickers as rows arrive, or
 * a duplicate row per tool call is invisible in a screenshot and obvious in use.
 */

/** The kinds of run event the agent records. */
export type CotEventKind =
  | "plan"
  | "step"
  | "observation"
  | "approval"
  | "result"
  | "error"
  | "status";

/** The smallest event shape this module needs. */
export interface CotEvent {
  id: string;
  date: string;
  kind: CotEventKind;
  title: string;
  detail: string;
}

/** What an accordion row shows. */
export interface CotStep {
  readonly id: string;
  /** The icon and colour the row is drawn with. */
  readonly icon: string;
  readonly tint: string;
  /** One short line, always complete, never cut mid-word. */
  readonly headline: string;
  /** The longer explanation, revealed when the row is expanded. */
  readonly detail: string;
  readonly kind: CotEventKind;
  readonly at: string;
  /** True for the newest row; only it is emphasised while running. */
  readonly current: boolean;
  /** True when the step needs a person: an error, or something awaiting review. */
  readonly needsAttention: boolean;
}

/** Every icon the accordion can use. Chosen so the set reads as one family. */
const ICONS: Record<CotEventKind, { icon: string; tint: string }> = {
  plan: { icon: "◷", tint: "#8FA6E8" },
  step: { icon: "⚡", tint: "#6AAEE0" },
  observation: { icon: "◍", tint: "#7FC4A4" },
  approval: { icon: "✋", tint: "#E0A85A" },
  result: { icon: "✓", tint: "#7FC4A4" },
  error: { icon: "!", tint: "#AA4A45" },
  status: { icon: "◷", tint: "#8FA6E8" },
};

/** Longest a headline may be before it is truncated. */
const MAX_HEADLINE = 92;

/**
 * Trim a line to a headline.
 *
 * Cut at a word boundary where one is near the limit, so a headline never ends
 * mid-word; failing that it just cuts. Trailing whitespace and a dangling
 * ellipsis are what make a truncated line look broken, so both are handled here
 * rather than left to the renderer.
 */
export const headline = (value: string, max = MAX_HEADLINE): string => {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Only respect the word boundary if it is not so early that almost nothing
  // survives: a three-character headline is worse than a slightly ragged one.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.-]+$/, "")}…`;
};

/**
 * One line for an event.
 *
 * The agent already writes these as short imperatives ("Searched the web"), so
 * the headline is the title. An event with no usable title falls back to its
 * detail, which is how a tool call with only a payload still gets a row.
 */
const lineFor = (event: CotEvent): string => {
  const title = event.title?.replace(/\s+/g, " ").trim();
  if (title) return title;
  const detail = event.detail?.replace(/\s+/g, " ").trim();
  if (detail) return detail;
  return ICONS[event.kind]?.icon ?? "·";
};
/**
 * Turn a run log into the rows an accordion shows, newest first.
 *
 * `max` bounds the list. This matters more than it looks: a monitoring task that
 * has been checking for a month has thousands of events, and rendering them all
 * to show the last few would make opening the task slower the longer it ran.
 */
export const toCotSteps = (events: readonly CotEvent[], max = 24): CotStep[] => {
  // Sorted by the event's own timestamp, not by array order: the log arrives
  // from a `date` column ordered by insertion, and a run whose events were
  // written in one transaction can come back out of order.
  const ordered = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const collapsed: CotEvent[] = [];
  for (const event of ordered) {
    const previous = collapsed.at(-1);
    // Only an immediately-preceding duplicate collapses. Two identical steps
    // separated by something else are two real steps, and merging them would
    // silently drop one from the record.
    if (previous && sameStep(previous, event)) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        // The later occurrence carries the newer timestamp and any detail the
        // first one lacked.
        detail: event.detail || previous.detail,
        date: event.date > previous.date ? event.date : previous.date,
      };
      continue;
    }
    collapsed.push(event);
  }
  const newestFirst = collapsed.reverse().slice(0, Math.max(0, max));
  return newestFirst.map((event, index) => {
    const style = ICONS[event.kind] ?? ICONS.status;
    return {
      id: event.id,
      icon: style.icon,
      tint: style.tint,
      headline: headline(lineFor(event)),
      detail: event.detail ?? "",
      kind: event.kind,
      at: event.date,
      current: index === 0,
      needsAttention: event.kind === "error" || event.kind === "approval",
    };
  });
};

/**
 * One line summarising what the agent is doing right now.
 *
 * Shown while a task runs so the screen is never just a spinner. It prefers a
 * step that needs attention, because that is the one a person is most likely to
 * be waiting on.
 */
export const summarise = (steps: readonly CotStep[]): string => {
  const attention = steps.find((step) => step.needsAttention);
  if (attention) return attention.headline;
  return steps.find((step) => step.current)?.headline ?? "";
};

/**
 * Height of an accordion row, in points.
 *
 * Pure so the animation's target can be asserted. A collapsed row is exactly
 * one line tall — never zero, because a row of zero height disappears and makes
 * the list look like it lost an entry.
 */
export const accordionHeight = (
  expanded: boolean,
  contentHeight: number,
  rowHeight: number,
): number => {
  const row = Math.max(0, Number.isFinite(rowHeight) ? rowHeight : 0);
  const content = Math.max(0, Number.isFinite(contentHeight) ? contentHeight : 0);
  return expanded ? Math.max(row, content) : row;
};

/**
 * True when two events would render as the same row.
 *
 * The agent records a `step` immediately before and a result after each tool
 * call, so the raw log carries near-duplicates. Collapsing them by kind and text
 * is what stops a long run from turning into fifty identical rows.
 */
const sameStep = (a: CotEvent, b: CotEvent) =>
  a.kind === b.kind && lineFor(a).toLowerCase() === lineFor(b).toLowerCase();
