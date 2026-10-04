import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

/**
 * A short window in which a non-destructive action can be taken back.
 *
 * The problem this solves is specific. Everything the agent does that touches an
 * outside service goes through a review gate, and the gate is right for
 * anything irreversible — a sent email, a deleted event. But a whole class of
 * action is *reversible*, and the gate turns it into friction: re-reading a
 * page, refreshing a document, re-running a check. Asking someone to approve
 * each of those trains them to approve without reading, which is exactly the
 * habit that makes the irreversible gate useless when it matters.
 *
 * So reversible actions run immediately and publish an undo window. If nobody
 * takes it, nothing happens. If someone does, the action is rolled back and the
 * world is as it was.
 *
 * The window is a timer, and timers are where this kind of code goes wrong: an
 * abandoned timer firing after the process restarts, a rollback racing the
 * forward action, two undos for the same id. Every one of those is a state
 * machine, so that is what this is, with the clock injected so the whole thing
 * is testable without waiting five seconds.
 */

/** How long the undo window stays open. */
export const UNDO_WINDOW_MS = 5000;

/** How long a settled entry stays readable before being forgotten. */
const SETTLED_RETENTION_MS = 120_000;

/** Ceiling on retained entries, so the queue cannot grow without bound. */
const MAX_RETAINED_ENTRIES = 500;

/** What the queue is doing with an entry. */
export type UndoStatus = "pending" | "committed" | "undone" | "failed";

/** One queued action. */
export interface UndoEntry<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  status: UndoStatus;
  /** When the window closes, as epoch milliseconds. */
  readonly expiresAt: number;
  /** Runs when the window closes without an undo. */
  readonly commit: () => Promise<T>;
  /** Runs when the person takes it back. Must be safe to call once only. */
  readonly undo: () => Promise<void>;
  /** When it left `pending`, so retention can be measured. Null while pending. */
  settledAt: number | null;
}

/** What the caller is told when it asks about an entry. */
export interface UndoView {
  readonly id: string;
  readonly label: string;
  readonly status: UndoStatus;
  /** Milliseconds until the window closes, 0 once it has. */
  readonly remainingMs: number;
}

export interface UndoQueueOptions {
  /** How long the window stays open. */
  windowMs?: number;
  /**
   * How long a settled entry stays readable before it is forgotten.
   *
   * It cannot be zero: the client polls for the terminal state so the toast can
   * disappear, and an undo that arrives just after the window closed should be
   * told "that already happened" rather than "no such action", which reads as a
   * bug to whoever pressed it.
   */
  settledRetentionMs?: number;
  /**
   * Ceiling on retained entries.
   *
   * A backstop for the case retention cannot bound: a caller queueing in a
   * tight loop with a very long retention. Oldest settled entries go first;
   * pending ones are never dropped, because a dropped pending entry is an
   * action whose timer fires into nothing.
   */
  maxEntries?: number;
  /** Injected so the tests can drive the clock. */
  now?: () => number;
  /** Injected so the tests can fire timers deliberately. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** Error raised when an undo is asked for that cannot happen. */
export class UndoUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = "UndoUnavailableError";
  }
}

/**
 * A queue of actions waiting to be confirmed by their own inaction.
 *
 * One entry per id: queueing the same id twice replaces the pending entry
 * rather than stacking a second one, so a retried request cannot fire the same
 * mutation twice.
 */
export class UndoQueue {
  private readonly entries = new Map<string, UndoEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(private readonly options: UndoQueueOptions = {}) {}

  private get windowMs() {
    return Math.max(0, this.options.windowMs ?? UNDO_WINDOW_MS);
  }
  private get retentionMs() {
    return Math.max(0, this.options.settledRetentionMs ?? SETTLED_RETENTION_MS);
  }
  private get maxEntries() {
    return Math.max(1, this.options.maxEntries ?? MAX_RETAINED_ENTRIES);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** How many entries are waiting. */
  get size() {
    return this.entries.size;
  }

  /** How many entries have a live timer. Used by tests and by shutdown. */
  get liveTimers() {
    return this.timers.size;
  }

  /**
   * Queue an action and start its undo window.
   *
   * The action has *not* run yet. It runs when the window closes, which is what
   * makes the window honest: nothing has happened, and undoing it is not a
   * compensation but simply not doing it.
   */
  queue<T>(options: {
    id: string;
    label: string;
    owner: string;
    commit: () => Promise<T>;
    undo: () => Promise<void>;
  }): UndoView {
    if (this.closed) throw new AppError("OpenMuse is shutting down. Try again in a moment.", 503);
    this.clearTimer(options.id);
    const entry: UndoEntry<T> = {
      id: options.id,
      label: options.label,
      owner: options.owner,
      status: "pending",
      expiresAt: this.now() + this.windowMs,
      settledAt: null,
      commit: options.commit,
      undo: options.undo,
    };
    this.entries.set(options.id, entry as UndoEntry);
    // Swept after the insert, not before: sweeping first would admit one more
    // entry than the ceiling allows, since the new one is counted only after it
    // is in the map.
    this.sweep();
    const timer = (this.options.setTimeoutFn ?? setTimeout)(() => {
      this.timers.delete(options.id);
      void this.settle(options.id);
    }, this.windowMs);
    // Never hold the process open for an undo window.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(options.id, timer);
    return this.view(entry);
  }

  /** One entry, or null. */
  peek(id: string): UndoView | null {
    const entry = this.entries.get(id);
    return entry ? this.view(entry) : null;
  }

  /** Every entry for one owner, newest window first. */
  forOwner(owner: string): UndoView[] {
    return [...this.entries.values()]
      .filter((entry) => entry.owner === owner)
      .map((entry) => this.view(entry));
  }

  private view(entry: UndoEntry): UndoView {
    return {
      id: entry.id,
      label: entry.label,
      status: entry.status,
      // Never negative: a caller rendering a countdown would otherwise show a
      // number below zero for the frame between expiry and the next render.
      remainingMs: entry.status === "pending" ? Math.max(0, entry.expiresAt - this.now()) : 0,
    };
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (!timer) return;
    (this.options.clearTimeoutFn ?? clearTimeout)(timer);
    this.timers.delete(id);
  }

  /**
   * Move an entry to a terminal state and record when.
   *
   * The stamp is what retention is measured from, and it is set on the way *in*
   * to the terminal state rather than after the action resolves: a commit that
   * takes ten seconds should not also be retained for ten seconds afterwards.
   */
  private settleStamp(entry: UndoEntry, status: UndoStatus) {
    entry.status = status;
    entry.settledAt = this.now();
  }

  /**
   * Forget entries nobody can use any more.
   *
   * Swept lazily on queue rather than on a timer, deliberately: a per-entry
   * eviction timer would be a second timer to leak and a second thing to
   * mis-cancel, and queueing is the only path that grows the map, so it is the
   * only place a bound is needed. Entries still inside their retention window
   * survive, which is what lets a client poll for a terminal state it has not
   * seen yet.
   *
   * Pending entries are never swept. Their timer still fires, and a pending
   * entry dropped here would leave that timer settling nothing.
   */
  private sweep() {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== null && entry.settledAt <= cutoff) this.entries.delete(id);
    }
    // Backstop for a caller queueing faster than retention expires entries.
    if (this.entries.size <= this.maxEntries) return;
    const settled = [...this.entries.values()]
      .filter((entry) => entry.settledAt !== null)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    for (const entry of settled) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(entry.id);
    }
  }

  /**
   * Take an action back.
   *
   * The timer is cancelled first and the entry claimed before anything
   * asynchronous happens. Without that ordering, an undo arriving in the same
   * tick the window closes races the commit: both see `pending`, and the action
   * runs *and* is rolled back.
   */
  async undo(id: string): Promise<UndoView> {
    const entry = this.entries.get(id);
    if (!entry) throw new UndoUnavailableError("That action is no longer available to undo.");
    if (entry.status !== "pending")
      throw new UndoUnavailableError(
        entry.status === "undone"
          ? "That action was already undone."
          : "That action has already happened and can no longer be undone.",
      );
    this.clearTimer(id);
    this.settleStamp(entry, "undone");
    try {
      await entry.undo();
    } catch (error) {
      // The person asked for the world to go back and it did not. That is worth
      // recording, because the next thing they will do is look for it.
      this.settleStamp(entry, "failed");
      backgroundFailure("undo action", error);
      throw new UndoUnavailableError("That action could not be taken back.");
    }
    return this.view(entry);
  }

  /**
   * Close the window and run the action.
   *
   * Idempotent: an entry that is not pending resolves to its current view
   * without running anything, so a timer firing just after an undo is harmless
   * rather than a second execution.
   */
  private async settle(id: string): Promise<UndoView | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.status !== "pending") return this.view(entry);
    this.settleStamp(entry, "committed");
    try {
      await entry.commit();
    } catch (error) {
      this.settleStamp(entry, "failed");
      backgroundFailure("deferred action", error);
    }
    return this.view(entry);
  }

  /** Close the window now, for an action that should not wait. */
  async commit(id: string): Promise<UndoView> {
    this.clearTimer(id);
    const entry = this.entries.get(id);
    if (!entry) throw new UndoUnavailableError("That action is no longer available.");
    const settled = await this.settle(id);
    if (!settled) throw new UndoUnavailableError("That action is no longer available.");
    return settled;
  }

  /**
   * Stop the queue.
   *
   * `commitPending` decides what happens to anything still waiting. On shutdown
   * nothing is committed: a process that is going away should not start a new
   * external write on its way out.
   */
  async close(options: { commitPending?: boolean } = {}) {
    this.closed = true;
    const pending = [...this.entries.values()].filter((entry) => entry.status === "pending");
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    if (options.commitPending) for (const entry of pending) await this.settle(entry.id);
    else for (const entry of pending) entry.status = "undone";
    this.entries.clear();
  }
}
