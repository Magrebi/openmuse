import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileIo, writeEnvWithBackup } from "../src/envfile.js";

/** In-memory FileIo that records what a write would have done. */
function fakeIo(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/repo/.env", initial);
  const writes: string[] = [];
  const copies: string[] = [];
  const io: FileIo = {
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    writeFile: async (path, contents) => {
      writes.push(path);
      files.set(path, contents);
    },
    exists: async (path) => files.has(path),
    copyFile: async (from, to) => {
      copies.push(`${from} -> ${to}`);
      const value = files.get(from);
      if (value === undefined) throw new Error("ENOENT");
      files.set(to, value);
    },
  };
  return { io, files, writes, copies };
}

test("writing .env backs up an existing file before overwriting it", async () => {
  const existing = "WORKER_TOKEN='keep-me'\nMODEL=openai/gpt-5\n";
  const { io, files, writes, copies } = fakeIo(existing);
  const result = await writeEnvWithBackup("/repo", { WORKER_TOKEN: "new-value" }, io, "20260101");
  assert.deepEqual(writes, ["/repo/.env"]);
  assert.equal(copies.length, 1, "the previous file is copied first");
  assert.equal(result.backup, "/repo/.env.bak-20260101");
  // The backup must hold the old value so a bad generation is recoverable.
  assert.equal(files.get("/repo/.env.bak-20260101"), existing);
  assert.ok(files.get("/repo/.env")?.includes("new-value"));
});

test("a first run creates .env without inventing a backup", async () => {
  const { io, writes, copies } = fakeIo();
  const result = await writeEnvWithBackup("/repo", { WORKER_TOKEN: "first-token" }, io, "20260101");
  assert.deepEqual(writes, ["/repo/.env"]);
  assert.deepEqual(copies, [], "there is nothing to back up");
  assert.equal(result.backup, undefined);
});

test("a failed backup stops the write so the old .env is never lost", async () => {
  const { io, writes } = fakeIo("WORKER_TOKEN='precious'\n");
  const failing: FileIo = {
    ...io,
    copyFile: async () => {
      throw new Error("EACCES");
    },
  };
  await assert.rejects(writeEnvWithBackup("/repo", { WORKER_TOKEN: "new" }, failing, "1"), {
    name: "DesktopError",
    code: "ENV_BACKUP_FAILED",
  });
  assert.deepEqual(writes, [], "nothing is written when the backup fails");
});

test("writes are confined to .env inside the repository", async () => {
  const { io, writes } = fakeIo();
  await writeEnvWithBackup("/repo", { WORKER_TOKEN: "x" }, io, "1");
  assert.deepEqual(writes, ["/repo/.env"]);
  assert.equal(
    writes.every((path) => path.startsWith("/repo/")),
    true,
  );
});
