import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-pdf-read-"));
  const db: Store = await createStore({ dataDir });
  const config = { dataDir, mode: "sample" } as unknown as Config;
  const auth = new Auth(db, config, "test-signing-key");
  const files = new Files(db, config, auth);
  const artifact = await files.import(
    "owner",
    "visit.pdf",
    await createSamplePdf(),
    "Uploaded by you",
  );
  return {
    dataDir,
    db,
    files,
    artifact,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test("an imported PDF's text can be read back through the owner-scoped service", async (t) => {
  const { files, artifact, cleanup } = await fixture();
  t.after(cleanup);
  const pages = await files.readText("owner", artifact.id);
  assert.equal(pages.length, artifact.pageCount);
  assert.match(pages.map((page) => page.text).join("\n"), /Community visit/);
});

test("reading one owner's PDF by another owner is refused", async (t) => {
  const { files, artifact, cleanup } = await fixture();
  t.after(cleanup);
  // The same check the bytes path uses, so an id cannot reach across owners.
  await assert.rejects(files.readText("someone-else", artifact.id), { status: 404 });
});

test("a page range outside the document is refused, not silently empty", async (t) => {
  const { files, artifact, cleanup } = await fixture();
  t.after(cleanup);
  await assert.rejects(files.readText("owner", artifact.id, { from: 9, to: 9 }), { status: 422 });
});
