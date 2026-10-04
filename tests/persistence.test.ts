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
// L1: expired session rows are collected instead of accumulating forever.
// ---------------------------------------------------------------------------

test("pruneExpired clears lapsed rows and leaves every other row alone", async () => {
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

    const left = (await db.list<{ id: string }>("system", "sessions")).map((r) => r.id).sort();
    // "boundary" is exactly at `now`, so `<=` collects it. "undated" and "odd"
    // survive because the digit guard skips them rather than raising.
    assert.deepEqual(left, ["odd", "undated", "valid"], "only lapsed rows are removed");
    assert.ok(!(await db.get("system", "sessions", "lapsed")));
    assert.ok(!(await db.get("system", "sessions", "boundary")));
    assert.equal(
      (await db.get("system", "oauth", "elsewhere"))?.id,
      "elsewhere",
      "another kind is never touched",
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

test("pruneExpired does not abort the statement for a malformed expiresAt", async () => {
  // The cast is the hazard: a single non-numeric value used to raise and take
  // every other row down with it. The anchored digit test runs before the cast.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-prune-bad-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const now = Date.now();
    await db.put("system", "sessions", { id: "bad", expiresAt: "2026-13-45T99:99:99Z" });
    await db.put("system", "sessions", { id: "also-bad", expiresAt: { nested: true } });
    await db.put("system", "sessions", { id: "good", expiresAt: now - 1 });

    await db.pruneExpired("system", "sessions", now);

    assert.ok(!(await db.get("system", "sessions", "good")), "the valid lapsed row is gone");
    assert.ok(await db.get("system", "sessions", "bad"), "the malformed row survives untouched");
    assert.ok(await db.get("system", "sessions", "also-bad"), "an object value survives too");
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L2: the scan index backing the 1s worker tick exists after startup", async () => {
  // L2: scan() filters on `kind` alone and runs on the 1s worker tick and the
  // 60s maintain() sweep. Without (kind, updated_at) every poll reads the whole
  // table. Asserted against the catalog rather than EXPLAIN: on a fixture-sized
  // table the planner is free to prefer a sequential read, which would make an
  // EXPLAIN assertion pass or fail on statistics rather than on the schema.
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-index-"));
  try {
    const db = await createStore({ dataDir: join(root, "pg") });
    const indexes = await db.indexNames();
    assert.ok(
      indexes.includes("records_kind_updated"),
      `expected records_kind_updated among ${JSON.stringify(indexes)}`,
    );
    // The primary key is always present; the point is that a secondary index
    // now exists rather than the table being index-free.
    assert.ok(indexes.includes("records_pkey"));
    // Startup is idempotent: re-running the DDL must not fail.
    const reopened = await createStore({ dataDir: join(root, "pg") });
    assert.deepEqual((await reopened.indexNames()).sort(), indexes.sort());
    await reopened.close();
    await db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
