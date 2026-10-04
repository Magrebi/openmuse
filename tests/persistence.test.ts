import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPool, createStore } from "../apps/server/src/db.ts";

test("fresh nested data directory starts and survives a database restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const options = { dataDir: join(root, "new-install", "postgres") };
    const first = await createStore(options);
    await first.put("owner", "actions", { id: "action1", status: "executing" });
    await first.close();
    const second = await createStore(options);
    await second.recoverInterruptedActions();
    assert.equal((await second.get("owner", "actions", "action1"))?.status, "outcome_unknown");
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listWhere returns only matching records, in the order the caller expects", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-where-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    // Two tasks' worth of events, interleaved in insertion order.
    await db.put("owner", "run-events", {
      id: "e1",
      taskId: "task-a",
      date: "2026-01-01T00:00:01.000Z",
    });
    await db.put("owner", "run-events", {
      id: "e2",
      taskId: "task-b",
      date: "2026-01-01T00:00:02.000Z",
    });
    await db.put("owner", "run-events", {
      id: "e3",
      taskId: "task-a",
      date: "2026-01-01T00:00:03.000Z",
    });
    const found = await db.listWhere<{ id: string; taskId: string }>(
      "owner",
      "run-events",
      "taskId",
      "task-a",
    );
    assert.deepEqual(
      found.map((row) => row.id),
      ["e1", "e3"],
      "only this task's events, oldest first",
    );
    // Another owner's record with the same field must never appear.
    await db.put("other", "run-events", {
      id: "e4",
      taskId: "task-a",
      date: "2026-01-01T00:00:00.000Z",
    });
    const owned = await db.listWhere<{ id: string }>("owner", "run-events", "taskId", "task-a");
    assert.ok(!owned.some((row) => row.id === "e4"), "ownership still applies");
    assert.deepEqual(await db.listWhere("owner", "run-events", "taskId", "missing"), []);

    // The planner is what decides whether this read scales, so assert on the
    // plan rather than on a wall-clock number, which would be flaky on a shared
    // runner. taskId must be an index condition, not a filter applied after the
    // planner has already read every row of that kind.
    const raw = db as unknown as {
      db: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
      };
    };
    const plan = await raw.db.query(
      "EXPLAIN (COSTS OFF) SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4 ORDER BY data->>'date' ASC,id ASC",
      ["owner", "run-events", "taskId", "task-a"],
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(text, /records_task_id/, `planner should use the taskId index:\n${text}`);
    assert.match(
      text,
      /Index Cond:.*taskId/,
      `taskId must be part of the index condition, not a post-filter:\n${text}`,
    );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchText matches the rule the in-memory filter used, and honours ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-search-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    await db.put("owner", "mail", {
      id: "m1",
      sender: "Aqua Tours",
      from: "bookings@aquatours.example",
      subject: "Trip confirmation",
      body: "The aquarium visit is confirmed.",
      label: "Inbox",
      date: "2026-02-01T00:00:00.000Z",
    });
    await db.put("owner", "mail", {
      id: "m2",
      sender: "You",
      subject: "Re: Trip confirmation",
      body: "sent copy",
      label: "Sent · local",
      date: "2026-03-01T00:00:00.000Z",
    });
    await db.put("owner", "mail", {
      id: "m3",
      sender: "Studio",
      subject: "Design review",
      body: "unrelated",
      label: "Inbox",
      date: "2026-01-01T00:00:00.000Z",
    });

    const mail = () =>
      db.searchText<{ id: string }>(
        "owner",
        "mail",
        ["sender", "from", "subject", "body"],
        ["trip"],
        { excludePattern: { field: "label", pattern: "^Sent\\y" }, order: "date_desc" },
      );

    // "trip" appears in a subject and a body; the Sent copy is excluded.
    assert.deepEqual(
      (await mail()).map((row) => row.id),
      ["m1"],
    );
    // Every word must match, and a word can come from any of the fields.
    assert.deepEqual(
      (
        await db.searchText<{ id: string }>(
          "owner",
          "mail",
          ["sender", "from", "subject", "body"],
          ["aqua", "aquarium"],
        )
      ).map((row) => row.id),
      ["m1"],
    );
    // A word that appears nowhere matches nothing.
    assert.deepEqual(
      (
        await db.searchText<{ id: string }>(
          "owner",
          "mail",
          ["sender", "from", "subject", "body"],
          ["trip", "nonexistentterm"],
        )
      ).map((row) => row.id),
      [],
    );
    // An empty query is not "match everything".
    assert.deepEqual(await db.searchText("owner", "mail", ["subject"], []), []);

    // Regression guard for a trap this move introduced: Postgres' `\b` is not a
    // word boundary, so `^Sent\b` matches nothing and sent mail leaks back into
    // results. `\y` is the equivalent and must behave like the JS regex did.
    for (const label of ["Sent · local", "Sent", "Inbox", "Sentry"]) {
      await db.put("owner", "labels", { id: label, label, body: "shared token" });
    }
    // Every row matches the term, so only the exclusion decides the result.
    const excluded = await db.searchText<{ label: string }>(
      "owner",
      "labels",
      ["body"],
      ["shared"],
      { excludePattern: { field: "label", pattern: "^Sent\\y" } },
    );
    assert.deepEqual(
      excluded.map((row) => row.label).sort(),
      ["Inbox", "Sentry"],
      "same labels the JavaScript /^Sent\\b/i filter kept",
    );
    // A field name that is not a plain identifier must never reach the query.
    await assert.rejects(
      () => db.searchText("owner", "mail", ["subject'); DROP TABLE records;--"], ["x"]),
      /Invalid search field/,
    );
    // The table is still there and its rows intact, so the guard ran before any
    // statement reached the database.
    assert.equal((await db.list<{ id: string }>("owner", "mail")).length, 3);
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchText treats a word's own wildcards as ordinary characters", async () => {
  // Regression guard for a trap in moving the search into SQL: the words are
  // concatenated into a LIKE pattern, so an unescaped `%`, `_` or `\` becomes a
  // wildcard. Searching "100%" then returned every body starting with "100", and
  // because a backslash is itself the LIKE escape, searching "a\zb" dropped the
  // row that really contained it and returned an unrelated one instead.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-wildcard-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const mail = [
      { id: "pct", body: "Total is 100% due" },
      { id: "digits", body: "Pay 1001 now" },
      { id: "plain", body: "Pay 100 now" },
      { id: "abc", body: "abc" },
      { id: "spaced", body: "a c" },
      { id: "literal-underscore", body: "field a_c name" },
      { id: "literal-backslash", body: "path a\\zb" },
      { id: "swallowed", body: "azb" },
    ];
    for (const message of mail)
      await db.put("owner", "mail", { ...message, subject: "s", date: "2026-01-01T00:00:00.000Z" });

    const ids = async (...words: string[]) =>
      (await db.searchText<{ id: string }>("owner", "mail", ["subject", "body"], words)).map(
        (row) => row.id,
      );

    assert.deepEqual(await ids("100%"), ["pct"], "only the row holding a literal 100%");
    assert.deepEqual(await ids("100"), ["digits", "pct", "plain"], "no escaping, no wildcarding");
    assert.deepEqual(
      await ids("a_c"),
      ["literal-underscore"],
      "_ matches an underscore, not any char",
    );
    assert.deepEqual(
      await ids("a\\zb"),
      ["literal-backslash"],
      "the row containing the backslash must be found, not swallowed as an escape",
    );
    assert.deepEqual(await ids("%"), ["pct"], "a lone % is not a match-everything wildcard");

    // Ordinary searches, case folding and the all-words rule are unaffected.
    assert.deepEqual(await ids("abc"), ["abc"]);
    assert.deepEqual(await ids("A_C"), ["literal-underscore"]);
    assert.deepEqual(await ids("field", "name"), ["literal-underscore"]);
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claim never lets an unusable expiresAt through or abort the statement", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-claim-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 600_000).toISOString();
    const past = new Date(Date.now() - 600_000).toISOString();
    await db.put("owner", "actions", { id: "live", status: "awaiting_review", expiresAt: future });
    await db.put("owner", "actions", { id: "missing", status: "awaiting_review" });
    await db.put("owner", "actions", {
      id: "garbage",
      status: "awaiting_review",
      expiresAt: "not-a-date",
    });
    await db.put("owner", "actions", { id: "stale", status: "awaiting_review", expiresAt: past });

    // A well-formed, unexpired action still claims exactly as before.
    const live = await db.claim<{ status: string }>("owner", "live", "executing", now);
    assert.equal(live?.status, "executing");

    // An unusable expiry must not claim, and must not abort the statement for
    // every other row: the cast used to raise and surface as an opaque 502.
    assert.equal(await db.claim("owner", "missing", "executing", now), null);
    assert.equal(await db.claim("owner", "garbage", "executing", now), null);
    assert.equal(
      await db.claim("owner", "stale", "executing", now),
      null,
      "expired rows never claim",
    );

    for (const id of ["missing", "garbage", "stale"])
      assert.equal(
        (await db.get<{ status: string }>("owner", "actions", id))?.status,
        "awaiting_review",
      );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneExpired clears lapsed rows and leaves everything else alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-prune-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const now = Date.now();
    await db.put("system", "sessions", { id: "lapsed", expiresAt: now - 1 });
    await db.put("system", "sessions", { id: "boundary", expiresAt: now });
    await db.put("system", "sessions", { id: "valid", expiresAt: now + 60_000 });
    await db.put("system", "sessions", { id: "undated" });
    await db.put("system", "sessions", { id: "odd", expiresAt: "not-a-number" });
    // Neighbours that share the word but not the owner+kind pair being pruned.
    await db.put("system", "oauth", { id: "elsewhere", expiresAt: now - 1 });
    await db.put("another-owner", "sessions", { id: "not-ours", expiresAt: now - 1 });

    await db.pruneExpired("system", "sessions", now);

    const left = (await db.list<{ id: string }>("system", "sessions")).map((row) => row.id).sort();
    assert.deepEqual(left, ["odd", "undated", "valid"], "only lapsed rows are removed");
    assert.ok(!(await db.get("system", "sessions", "lapsed")));
    assert.equal(
      (await db.get("system", "oauth", "elsewhere"))?.id,
      "elsewhere",
      "kind is respected",
    );
    assert.equal(
      (await db.get("another-owner", "sessions", "not-ours"))?.id,
      "not-ours",
      "another owner is never touched",
    );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle Postgres client errors are logged instead of crashing the process", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const pool = createPool("postgres://127.0.0.1:1/openmuse");
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection")));
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Index registration, verified against the catalog rather than EXPLAIN.
// ---------------------------------------------------------------------------

test("the worker tick's scan index is registered and startup DDL is idempotent", async () => {
  // scan() filters on `kind` alone and runs on the 1s worker tick, so the index
  // is asserted against pg_indexes. EXPLAIN is deliberately not used: on a
  // fixture-sized table the planner may legitimately prefer a sequential scan,
  // which would make the assertion depend on statistics rather than on schema.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-index-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const indexes = await db.indexNames();
    assert.ok(
      indexes.includes("records_kind_updated"),
      `expected records_kind_updated among ${JSON.stringify(indexes)}`,
    );
    assert.ok(indexes.includes("records_task_id"), "the taskId index is registered");
    // Re-running the DDL on an existing data directory must not fail or duplicate.
    const reopened = await createStore({ dataDir: join(root, "pg") });
    assert.deepEqual((await reopened.indexNames()).sort(), indexes.sort());
    await reopened.close();
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Calendar range filtering, pushed into SQL.
// ---------------------------------------------------------------------------

test("listEventsInRange returns only events overlapping the window, in start order", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-events-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const event = (id: string, start: string, end: string, calendarId = "primary") =>
      db.put("owner", "events", { id, calendarId, start, end, title: id });
    // Inserted deliberately out of order so the ORDER BY is doing real work.
    await event("late", "2026-03-10T10:00:00.000Z", "2026-03-10T11:00:00.000Z");
    await event("early", "2026-03-01T09:00:00.000Z", "2026-03-01T10:00:00.000Z");
    await event("boundary", "2026-03-05T00:00:00.000Z", "2026-03-05T01:00:00.000Z");
    // A different calendar must never leak into the primary calendar's read.
    await event("other-cal", "2026-03-01T09:00:00.000Z", "2026-03-01T10:00:00.000Z", "work");

    const inMarch = await db.listEventsInRange<{ id: string }>(
      "owner",
      "events",
      "calendarId",
      "primary",
      { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" },
    );
    assert.deepEqual(
      inMarch.map((e) => e.id),
      ["early", "boundary", "late"],
      "sorted by start, and only the requested calendar",
    );

    // A window that overlaps only the middle event.
    const middle = await db.listEventsInRange<{ id: string }>(
      "owner",
      "events",
      "calendarId",
      "primary",
      { from: "2026-03-05T00:30:00.000Z", to: "2026-03-05T00:45:00.000Z" },
    );
    assert.deepEqual(
      middle.map((e) => e.id),
      ["boundary"],
      "partial overlap still counts",
    );

    // An empty window returns nothing rather than everything.

    test("listEventsInRange compares instants, not wall-clock strings, across offsets", async () => {
      // 2026-03-08 is the US DST transition: 02:30 local does not exist that day, so
      // a wall-clock string comparison and an instant comparison disagree here.
      const root = await mkdtemp(join(tmpdir(), "openmuse-db-events-tz-"));
      try {
        const db = await createStore({ dataDir: join(root, "pg") });
        // Stored with a -05:00 offset, so this event starts at 07:30Z.
        await db.put("owner", "events", {
          id: "dst",
          calendarId: "primary",
          start: "2026-03-08T02:30:00-05:00",
          end: "2026-03-08T04:30:00-04:00",
        });
        // Same wall-clock digits, different instant (+01:00), a day earlier: 01:30Z
        // on 03-07.
        await db.put("owner", "events", {
          id: "offset",
          calendarId: "primary",
          start: "2026-03-07T02:30:00+01:00",
          end: "2026-03-07T04:30:00+01:00",
        });

        // A window covering 03-08 in UTC must select only the DST event.
        const day = await db.listEventsInRange<{ id: string }>(
          "owner",
          "events",
          "calendarId",
          "primary",
          { from: "2026-03-08T00:00:00Z", to: "2026-03-09T00:00:00Z" },
        );
        assert.deepEqual(
          day.map((e) => e.id),
          ["dst"],
          "the offset event is a different instant",
        );

        // Ordering is by instant: offset (01:30Z on 03-07) precedes dst (07:30Z on 03-08).
        const both = await db.listEventsInRange<{ id: string }>(
          "owner",
          "events",
          "calendarId",
          "primary",
        );
        assert.deepEqual(
          both.map((e) => e.id),
          ["offset", "dst"],
        );
        await db.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("listEventsInRange skips a malformed timestamp instead of aborting the read", async () => {
      // The cast is the hazard: without the ISO shape test before it, one bad row
      // raises and takes every other event in the calendar down with it — the same
      // failure mode the claim path guards against.
      const root = await mkdtemp(join(tmpdir(), "openmuse-db-events-bad-"));
      try {
        const db = await createStore({ dataDir: join(root, "pg") });
        await db.put("owner", "events", {
          id: "good",
          calendarId: "primary",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        });
        await db.put("owner", "events", {
          id: "bad-start",
          calendarId: "primary",
          start: "not-a-date",
          end: "2026-03-01T10:00:00.000Z",
        });
        await db.put("owner", "events", {
          id: "bad-end",
          calendarId: "primary",
          start: "2026-03-01T09:00:00.000Z",
          end: { nested: true },
        });

        const found = await db.listEventsInRange<{ id: string }>(
          "owner",
          "events",
          "calendarId",
          "primary",
          { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
        );
        assert.deepEqual(
          found.map((e) => e.id),
          ["good"],
          "the good event survives the bad rows",
        );
        // The bad rows are not deleted; they are merely not matched.
        assert.ok(await db.get("owner", "events", "bad-start"), "no data is destroyed");
        await db.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("listEventsInRange rejects an unparseable window rather than silently matching nothing", async () => {
      const root = await mkdtemp(join(tmpdir(), "openmuse-db-events-badwin-"));
      try {
        const db = await createStore({ dataDir: join(root, "pg") });
        await db.put("owner", "events", {
          id: "e1",
          calendarId: "primary",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        });
        // An unparseable bound would make every comparison false, returning an empty
        // calendar that reads as "no events" rather than as a caller mistake.
        await assert.rejects(
          db.listEventsInRange("owner", "events", "calendarId", "primary", { from: "yesterday" }),
          /ISO-8601/,
        );
        await assert.rejects(
          db.listEventsInRange("owner", "events", "calendarId", "primary", { to: "2026-13-45" }),
          /ISO-8601/,
        );
        // Omitted bounds stay legal.
        await db.listEventsInRange("owner", "events", "calendarId", "primary", {});
        await db.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    const none = await db.listEventsInRange<{ id: string }>(
      "owner",
      "events",
      "calendarId",
      "primary",
      { from: "2026-05-01T00:00:00.000Z", to: "2026-05-02T00:00:00.000Z" },
    );
    assert.deepEqual(none, [], "a window past every event returns nothing");

    // Omitting both bounds returns the whole calendar, as the previous
    // unbounded JavaScript filter did.
    const all = await db.listEventsInRange<{ id: string }>(
      "owner",
      "events",
      "calendarId",
      "primary",
    );
    assert.deepEqual(
      all.map((e) => e.id),
      ["early", "boundary", "late"],
    );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listRecent returns a prefix of the full list, capped", async () => {
  // The leak this pins: activity and run events are append-only, and reading
  // them whole made an ordinary refresh cost more the longer the workspace had
  // been used. The client renders the recent ones and nothing else.
  //
  // The assertion is "a prefix of the full read" rather than "the newest is
  // first", because several rows written in the same millisecond share an
  // `updated_at` and their relative order is decided by the id tiebreak. What
  // matters is that the capped read is exactly the head of the ordered list and
  // that the head is bounded.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-recent-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    for (let i = 0; i < 25; i++) {
      await db.put("owner", "activity", { id: `a${i}`, n: i });
      // Distinct timestamps so "newest" is well defined for the assertion below.
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = await db.list<{ n: number }>("owner", "activity");
    const recent = await db.listRecent<{ n: number }>("owner", "activity", 10);
    assert.equal(all.length, 25);
    assert.equal(recent.length, 10, "the read must be capped");
    assert.deepEqual(
      recent.map((r) => r.n),
      all.slice(0, 10).map((r) => r.n),
      "the capped read must be the head of the ordered list",
    );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listRecent clamps a limit that would be a full table scan", async () => {
  // A caller asking for "everything" must not be able to make this the very scan
  // it was added to avoid.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-clamp-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    for (let i = 0; i < 5; i++) await db.put("owner", "activity", { id: `a${i}` });
    assert.equal((await db.listRecent("owner", "activity", 0)).length, 1);
    assert.equal((await db.listRecent("owner", "activity", -3)).length, 1);
    assert.equal((await db.listRecent("owner", "activity", 10_000)).length, 5);
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trimOlderThan keeps the newest rows and deletes the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-trim-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    for (let i = 0; i < 20; i++) {
      await db.put("owner", "run-events", { id: `e${i}`, n: i });
      // Distinct timestamps, so "the newest survive" is well defined.
      await new Promise((r) => setTimeout(r, 2));
    }
    const removed = await db.trimOlderThan("owner", "run-events", 5);
    assert.equal(removed, 15);
    const kept = await db.list<{ n: number }>("owner", "run-events");
    assert.equal(kept.length, 5);
    assert.equal(
      Math.max(...kept.map((row) => row.n)),
      19,
      "the newest rows must be the ones that survive",
    );
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trimming one owner's history leaves another owner's alone", async () => {
  // Housekeeping that reaches across owners would delete somebody's evidence
  // because somebody else generated a lot of activity.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-trim-owner-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    for (let i = 0; i < 10; i++) {
      await db.put("noisy", "activity", { id: `n${i}` });
      await db.put("quiet", "activity", { id: `q${i}` });
    }
    await db.trimOlderThan("noisy", "activity", 2);
    assert.equal((await db.list("noisy", "activity")).length, 2);
    assert.equal((await db.list("quiet", "activity")).length, 10);
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owners lists each owner once however many records they have", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-owners-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    for (let i = 0; i < 4; i++) await db.put("alice", "activity", { id: `a${i}` });
    await db.put("bob", "activity", { id: "b0" });
    assert.deepEqual(await db.owners(), ["alice", "bob"]);
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
