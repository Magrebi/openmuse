import assert from "node:assert/strict";
import { test } from "node:test";
import { UNDO_WINDOW_MS, UndoQueue } from "../apps/server/src/undo.ts";

/**
 * A queue driven by a fake clock, so the five-second window can be tested
 * without any test actually waiting five seconds.
 */
function harness(options: { windowMs?: number; retentionMs?: number; maxEntries?: number } = {}) {
  let clock = 1_000_000;
  /** When each timer is due, so "elapse" means "reach this instant". */
  const timers = new Map<number, { fn: () => void; dueAt: number; cleared: boolean }>();
  let next = 1;
  const queue = new UndoQueue({
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    ...(options.retentionMs === undefined ? {} : { settledRetentionMs: options.retentionMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    now: () => clock,
    setTimeoutFn: ((fn: () => void, delay: number) => {
      const timer = { fn, dueAt: clock + delay, cleared: false };
      timers.set(next, timer);
      return next++ as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      const timer = timers.get(id as number);
      if (timer) timer.cleared = true;
      timers.delete(id as number);
    }) as unknown as typeof clearTimeout,
  });
  return {
    queue,
    /** Advance the clock without firing anything. */
    advance(ms: number) {
      clock += ms;
    },
    /**
     * Reach `clock + ms`, firing every timer that is now due. Recording an
     * absolute due time per timer rather than a delay is what lets two entries
     * queued at different moments keep their own independent windows.
     */
    async elapse(ms: number) {
      clock += ms;
      for (const timer of [...timers.values()]) {
        if (timer.cleared || timer.dueAt > clock) continue;
        timer.cleared = true;
        timer.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    get liveTimers() {
      return [...timers.values()].filter((t) => !t.cleared).length;
    },
  };
}

/** A queued action that records what ran. */
function spy() {
  const calls = { commit: 0, undo: 0 };
  return {
    calls,
    commit: async () => {
      calls.commit++;
    },
    undo: async () => {
      calls.undo++;
    },
  };
}

const queueOn = (h: ReturnType<typeof harness>, id: string, action: ReturnType<typeof spy>) =>
  h.queue.queue({
    id,
    label: "Refreshing the page",
    owner: "local-user",
    commit: action.commit,
    undo: action.undo,
  });

test("the default window is five seconds", () => {
  assert.equal(UNDO_WINDOW_MS, 5000);
});

test("queueing does not run the action — the window is what runs it", () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  assert.equal(action.calls.commit, 0, "nothing may happen before the window closes");
  assert.equal(h.queue.peek("a")?.status, "pending");
});

test("the action runs when the window closes, and never runs twice", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  await h.elapse(5000);
  assert.equal(action.calls.commit, 1);
  assert.equal(h.queue.peek("a")?.status, "committed");
  // A stray timer firing later must not execute a second time.
  await h.elapse(10_000);
  assert.equal(action.calls.commit, 1, "the action ran more than once");
});

test("an undo inside the window runs the rollback and never the action", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  h.advance(1000);
  const view = await h.queue.undo("a");
  assert.equal(view.status, "undone");
  assert.equal(action.calls.undo, 1);
  assert.equal(action.calls.commit, 0, "an undone action must never run");
  // And the timer that was cancelled must not resurrect it.
  await h.elapse(10_000);
  assert.equal(action.calls.commit, 0);
});

test("an undo and the window closing at once cannot both win", async () => {
  // The race that motivates claiming the entry before awaiting anything: both
  // would see `pending`, and the action would both run and be rolled back.
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  h.advance(5000);
  const [undone] = await Promise.all([h.queue.undo("a"), h.elapse(5000)]);
  assert.equal(undone.status, "undone");
  assert.equal(action.calls.commit + action.calls.undo, 1, "exactly one of the two must run");
});

test("an action past its window cannot be undone, and says why", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  await h.elapse(5000);
  await assert.rejects(h.queue.undo("a"), /already happened/);
  assert.equal(action.calls.undo, 0, "a committed action must not be rolled back");
});

test("undoing twice reports that it was already undone", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  await h.queue.undo("a");
  await assert.rejects(h.queue.undo("a"), /already undone/);
  assert.equal(action.calls.undo, 1);
});

test("undoing something unknown is refused, not silently ignored", async () => {
  const h = harness();
  await assert.rejects(h.queue.undo("never-queued"), /no longer available/);
});

test("queueing the same id twice replaces the entry rather than stacking one", () => {
  // A retried request must not be able to fire the same mutation twice.
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  queueOn(h, "a", action);
  queueOn(h, "a", action);
  assert.equal(h.queue.size, 1);
  assert.equal(h.liveTimers, 1, "the replaced entry's timer must be cancelled");
});

test("the countdown never goes negative", () => {
  const h = harness();
  queueOn(h, "a", spy());
  assert.equal(h.queue.peek("a")?.remainingMs, 5000);
  h.advance(2000);
  assert.equal(h.queue.peek("a")?.remainingMs, 3000);
  h.advance(10_000);
  assert.ok((h.queue.peek("a")?.remainingMs ?? -1) >= 0, "a negative countdown would be displayed");
});

test("a rollback that fails is reported and recorded, not swallowed", async () => {
  const h = harness();
  h.queue.queue({
    id: "a",
    label: "Refreshing",
    owner: "local-user",
    commit: async () => {},
    undo: async () => {
      throw new Error("the page is gone");
    },
  });
  await assert.rejects(h.queue.undo("a"), /could not be taken back/);
  assert.equal(h.queue.peek("a")?.status, "failed", "the failure must be visible afterwards");
});

test("a commit that fails is recorded rather than thrown into a timer", async () => {
  const h = harness();
  h.queue.queue({
    id: "a",
    label: "Refreshing",
    owner: "local-user",
    commit: async () => {
      throw new Error("the worker is gone");
    },
    undo: async () => {},
  });
  await h.elapse(5000);
  assert.equal(h.queue.peek("a")?.status, "failed");
});

test("entries are scoped to their owner and never leak across people", () => {
  const h = harness();
  h.queue.queue({
    id: "mine",
    label: "Mine",
    owner: "alice",
    commit: async () => {},
    undo: async () => {},
  });
  h.queue.queue({
    id: "theirs",
    label: "Theirs",
    owner: "bob",
    commit: async () => {},
    undo: async () => {},
  });
  assert.deepEqual(
    h.queue.forOwner("alice").map((e) => e.id),
    ["mine"],
  );
  assert.deepEqual(
    h.queue.forOwner("bob").map((e) => e.id),
    ["theirs"],
  );
  assert.deepEqual(h.queue.forOwner("nobody"), []);
});

test("an owner cannot discover another person's pending action", () => {
  // The queue is keyed by id alone, so authorisation belongs at the boundary.
  // This pins the shape a route relies on: `forOwner` is the only enumeration,
  // and a caller that checks membership first cannot be tricked into acting.
  const h = harness();
  const action = spy();
  h.queue.queue({
    id: "a",
    label: "Alice's",
    owner: "alice",
    commit: action.commit,
    undo: action.undo,
  });
  assert.equal(
    h.queue.forOwner("bob").some((e) => e.id === "a"),
    false,
    "bob must not be able to discover alice's entry",
  );
});

test("committing early runs the action now and cancels the timer", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  const view = await h.queue.commit("a");
  assert.equal(view.status, "committed");
  assert.equal(action.calls.commit, 1);
  assert.equal(h.liveTimers, 0);
  await h.elapse(10_000);
  assert.equal(action.calls.commit, 1);
});

test("committing something unknown is refused", async () => {
  const h = harness();
  await assert.rejects(h.queue.commit("never-queued"), /no longer available/);
});

test("closing abandons pending actions rather than starting them", async () => {
  // A process that is going away must not begin a new external write on its way
  // out; the action is simply never taken. This is the shape the server's
  // shutdown uses, so it is the property that keeps a restart from firing
  // something nobody approved.
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  await h.queue.close();
  await h.elapse(10_000);
  assert.equal(action.calls.commit, 0);
  assert.equal(h.queue.size, 0);
  assert.equal(h.liveTimers, 0);
});

test("closing does not reject an undo that arrives afterwards", async () => {
  // The shutdown closes the queue while a client may still be mid-request. That
  // undo must fail cleanly rather than reject with something the error handler
  // turns into a crash report.
  const h = harness();
  queueOn(h, "a", spy());
  await h.queue.close();
  await assert.rejects(h.queue.undo("a"), /no longer available/);
});

test("closing can commit pending actions when a caller asks it to", async () => {
  const h = harness();
  const action = spy();
  queueOn(h, "a", action);
  await h.queue.close({ commitPending: true });
  assert.equal(action.calls.commit, 1);
});

test("a closed queue refuses new work rather than losing it silently", async () => {
  const h = harness();
  await h.queue.close();
  assert.throws(() => queueOn(h, "a", spy()), /shutting down/);
});

test("a zero-length window commits at once without ever becoming pending", async () => {
  const h = harness({ windowMs: 0 });
  const action = spy();
  queueOn(h, "a", action);
  await h.elapse(0);
  assert.equal(action.calls.commit, 1);
});

test("many independent actions each keep their own window", async () => {
  const h = harness();
  const first = spy();
  const second = spy();
  queueOn(h, "a", first);
  h.advance(4000);
  h.queue.queue({
    id: "b",
    label: "Second",
    owner: "local-user",
    commit: second.commit,
    undo: second.undo,
  });
  // Undoing the second must not disturb the first, which is already 4s old.
  await h.queue.undo("b");
  h.advance(1000);
  await h.elapse(1000);
  assert.equal(first.calls.commit, 1, "the older entry must still commit on its own schedule");
  assert.equal(second.calls.commit, 0);
  assert.equal(second.calls.undo, 1);
});

test("the label survives, so the toast can say what is being undone", () => {
  const h = harness();
  h.queue.queue({
    id: "a",
    label: "Moved “Coffee with Jamie” to Friday",
    owner: "local-user",
    commit: async () => {},
    undo: async () => {},
  });
  assert.equal(h.queue.peek("a")?.label, "Moved “Coffee with Jamie” to Friday");
  assert.equal(h.queue.peek("missing"), null);
});

test("settled entries are forgotten, so a long-lived process does not grow", async () => {
  // The leak this pins: entries were only ever added and never removed, so every
  // action the agent ever ran left its callbacks — and whatever they close over
  // — resident for the life of the process.
  const h = harness({ retentionMs: 1_000 });
  for (let i = 0; i < 50; i++) {
    queueOn(h, `a-${i}`, spy());
    await h.elapse(5_000); // the window closes and the action commits
    h.advance(2_000); // and its retention then lapses
  }
  assert.ok(
    h.queue.size <= 1,
    `the queue should not grow with the number of actions, but held ${h.queue.size} of 50`,
  );
});

test("an entry inside its retention window is still readable", async () => {
  // Retention must not be so aggressive that the client misses the terminal
  // state: the toast polls for it to know the window closed.
  const h = harness({ retentionMs: 60_000 });
  queueOn(h, "a", spy());
  await h.elapse(5_000);
  assert.equal(h.queue.size, 1);
  assert.equal(h.queue.forOwner("local-user")[0]?.status, "committed");
});

test("an undo just after the window closes says it already happened", async () => {
  // "No such action" would read as a bug to whoever pressed Undo. Retention is
  // what preserves the difference between too late and never existed.
  const h = harness({ retentionMs: 60_000 });
  const action = spy();
  queueOn(h, "a", action);
  await h.elapse(5_000);
  await assert.rejects(h.queue.undo("a"), /already happened/);
  assert.equal(action.calls.undo, 0, "a late undo must not run the rollback");
});

test("the entry ceiling bounds retention even when it would never lapse", async () => {
  // Retention alone does not bound a caller that queues faster than entries
  // expire, so a hard ceiling sits behind it.
  const h = harness({ retentionMs: 10_000_000, maxEntries: 10 });
  for (let i = 0; i < 40; i++) {
    queueOn(h, `a-${i}`, spy());
    await h.queue.commit(`a-${i}`);
  }
  assert.ok(h.queue.size <= 10, `the ceiling was breached: ${h.queue.size}`);
});

test("the ceiling evicts the oldest settled entry first", async () => {
  // Evicting arbitrarily would drop the entry a client is most likely to still
  // be asking about, which is the most recent one.
  const h = harness({ retentionMs: 10_000_000, maxEntries: 2 });
  for (const id of ["old", "middle", "new"]) {
    queueOn(h, id, spy());
    await h.queue.commit(id);
    h.advance(10);
  }
  assert.equal(h.queue.peek("old"), null, "the oldest should have gone first");
  assert.ok(h.queue.peek("middle"), "the newer entries must survive");
  assert.ok(h.queue.peek("new"), "the newest must survive");
});

test("sweeping never drops an entry whose window is still open", async () => {
  // A swept pending entry would leave its timer settling nothing, so the action
  // would silently never run — the worst outcome undo could have.
  const h = harness({ retentionMs: 0, maxEntries: 1 });
  queueOn(h, "older", spy());
  queueOn(h, "newer", spy()); // trips the ceiling while both are still pending
  assert.equal(h.queue.peek("older")?.status, "pending");
  assert.equal(h.queue.peek("newer")?.status, "pending");
  const action = spy();
  queueOn(h, "watched", action);
  await h.elapse(5_000);
  assert.equal(action.calls.commit, 1, "a swept pending entry would never commit");
});
