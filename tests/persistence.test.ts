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
