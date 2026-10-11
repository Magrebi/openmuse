import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LibraryService } from "../apps/server/src/library.ts";
import { OcrQueue } from "../apps/server/src/ocr-queue.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

const text = { text: "Recognized invoice", truncated: false, ocr: true };

async function fixture() {
  const owner = randomUUID();
  const id = randomUUID();
  const queue = new OcrQueue(1, 8, "eng");
  const library = new LibraryService(db, { dataDir: "/unused" } as Config, queue);
  await db.put(owner, "library", {
    id,
    filename: "scan.png",
    mimeType: "image/png",
    sizeBytes: 100,
    createdAt: new Date().toISOString(),
    source: "upload",
    extraction: "pending",
  });
  // Control the subprocess boundary without requiring installed OCR binaries.
  const recognizer = library as unknown as {
    ocrImage: (path: string, languages: string, signal: AbortSignal) => Promise<typeof text>;
  };
  return { owner, id, queue, library, recognizer };
}

for (const partialResult of [false, true]) {
  test(`shutdown preserves pending OCR and restart recovers it (${partialResult ? "partial result" : "rejection"})`, async () => {
    const { owner, id, queue, library, recognizer } = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    recognizer.ocrImage = async (_, __, signal) => {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            if (partialResult) resolve(text);
            else reject(signal.reason);
          },
          { once: true },
        );
      });
    };
    try {
      assert.equal(await library.resweepPendingOcr(), 1);
      await ready;
      await queue.stop();
      assert.equal((await library.get(owner, id)).extraction, "pending");
      assert.equal(await db.get(owner, "library-text", id), null);
      recognizer.ocrImage = async () => text;
      queue.start();
      assert.equal(await library.resweepPendingOcr(), 1);
      const deadline = Date.now() + 5000;
      while (queue.status.running && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(queue.status.running, 0);
      assert.equal((await library.get(owner, id)).extraction, "ready");
      assert.equal((await db.get(owner, "library-text", id))?.text, text.text);
    } finally {
      await queue.stop();
    }
  });
}

test("a genuine recognition failure remains failed and is not retried on restart", async () => {
  const { owner, id, queue, library, recognizer } = await fixture();
  recognizer.ocrImage = async () => {
    throw new Error("Corrupt image");
  };
  try {
    await library.resweepPendingOcr();
    const deadline = Date.now() + 5000;
    while (queue.status.running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queue.status.running, 0);
    assert.equal((await library.get(owner, id)).extraction, "failed");
    await queue.stop();
    queue.start();
    assert.equal(await library.resweepPendingOcr(), 0);
  } finally {
    await queue.stop();
  }
});

test("deleting an in-flight document does not recreate metadata or its text index", async () => {
  const { owner, id, queue, library, recognizer } = await fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  recognizer.ocrImage = async (_, __, signal) => {
    started();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(text), { once: true });
    });
  };
  try {
    await library.resweepPendingOcr();
    await ready;
    await library.delete(owner, id);
    await queue.stop();
    assert.equal(await db.get(owner, "library", id), null);
    assert.equal(await db.get(owner, "library-text", id), null);
    queue.start();
    assert.equal(await library.resweepPendingOcr(), 0);
  } finally {
    await queue.stop();
  }
});

test("deletion between the extraction-state read and write cannot resurrect a document", async () => {
  const { owner, id, queue, library, recognizer } = await fixture();
  recognizer.ocrImage = async () => text;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalGet = db.get.bind(db);
  let intercept = true;
  db.get = async <T = Record<string, unknown>>(...args: Parameters<Store["get"]>) => {
    const result = await originalGet<T>(...args);
    if (
      intercept &&
      args[0] === owner &&
      args[1] === "library" &&
      args[2] === id &&
      (await originalGet(owner, "library-text", id))
    ) {
      intercept = false;
      entered();
      await gate;
    }
    return result;
  };
  try {
    await library.resweepPendingOcr();
    await ready;
    await library.delete(owner, id);
    release();
    await queue.stop();
    assert.equal(await db.get(owner, "library", id), null);
    assert.equal(await db.get(owner, "library-text", id), null);
  } finally {
    release();
    db.get = originalGet;
    await queue.stop();
  }
});
