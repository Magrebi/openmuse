import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";

test("every supported input reaches a real page and refreshes the session", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-input-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://example.com/");
    const before = await browser.read(id);
    // Each action returns refreshed session metadata. Together these cover the whole
    // dispatch, so a refactor of the input handling cannot silently stop one branch.
    for (const input of [
      { type: "scroll", deltaY: 500 },
      { type: "key", key: "Tab" },
      { type: "text", text: "hello" },
      // The far corner of example.com is empty, so this must not navigate anywhere.
      { type: "click", x: 1270, y: 790 },
    ]) {
      const session = await browser.input(id, input);
      assert.equal(session.id, id);
      assert.equal(session.status, "active");
    }
    const after = await browser.read(id);
    assert.equal(after.url, before.url, "input on an inert corner must not navigate");
    // Bounds are still enforced by the worker itself, whatever the server sent.
    for (const input of [
      { type: "click", x: 1280, y: 0 },
      { type: "click", x: 0, y: 800 },
      { type: "text", text: "x".repeat(10_001) },
      { type: "key", key: "F5" },
      { type: "scroll", deltaY: 5001 },
    ])
      await assert.rejects(browser.input(id, input), { code: "INVALID_INPUT" });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("real Chromium cleans failed profiles and restores a saved UUID after worker restart", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-lifecycle-"));
  let browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  const failedId = randomUUID();
  try {
    await assert.rejects(
      browser.create(
        failedId,
        "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8790%2Fhealth",
      ),
      { code: "NAVIGATION_FAILED" },
    );
    assert.equal(browser.list().length, 0, "failed creation must release its saved-profile slot");
    assert.equal(
      (await readdir(dataDir)).includes(failedId),
      false,
      "unclaimed profile is removed",
    );
    await browser.create(id, "https://example.com/");
    await browser.closeSession(id);
    const context = await chromium.launchPersistentContext(join(dataDir, id, "profile"), {
      headless: true,
    });
    try {
      const page = await context.newPage();
      await page.goto("https://example.com/");
      await page.evaluate(() => localStorage.setItem("openmuse-profile-test", "retained"));
    } finally {
      await context.close();
    }
    await browser.close();
    browser = await createBrowserManager({ dataDir });
    assert.equal(browser.list()[0]?.status, "closed");
    const reopened = await browser.create(id, "https://example.com/");
    assert.equal(reopened.id, id);
    assert.equal(reopened.title, "Example Domain");
    const read = await browser.read(id);
    // example.com's body copy changes; only its title is stable.
    assert.ok(read.text.trim().length > 0);
    await browser.navigate(id, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    const largeRead = await browser.read(id);
    assert.equal(largeRead.text.length, 100_000);
    assert.equal(largeRead.truncated, true);
    assert.equal(largeRead.url, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    await browser.closeSession(id);
    const state = JSON.parse(await readFile(join(dataDir, id, "storage.json"), "utf8"));
    assert(
      state.origins
        .find((origin: { origin: string }) => origin.origin === "https://example.com")
        ?.localStorage.some(
          (item: { name: string; value: string }) =>
            item.name === "openmuse-profile-test" && item.value === "retained",
        ),
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
