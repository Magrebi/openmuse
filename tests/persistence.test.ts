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
