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
