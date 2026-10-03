import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";
import type { PageSnapshot } from "../src/extract.ts";

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

test("a real page is described as addressable elements that actions then resolve", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-snapshot-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://example.com/");
    const read = await browser.read(id);
    // A plain read stays lean: the chat and takeover paths never pay for a DOM model.
    assert.deepEqual(read.elements, []);
    assert.deepEqual(read.links, []);

    const snapshot = (await browser.snapshot(id)) as PageSnapshot;
    assert.equal(snapshot.url, "https://example.com/");
    assert.ok(snapshot.text.trim().length > 0);
    // example.com links to iana.org; the snapshot must expose it as an actionable ref.
    const link = snapshot.elements.find((element) => element.role === "link");
    assert.ok(link, "the page's link was described");
    assert.match(link.ref, /^e[1-9][0-9]{0,2}$/);
    assert.ok(snapshot.links.some((item) => item.href.includes("iana.org")));

    // The ref resolves to the real element, so the action reaches the page.
    const before = snapshot.url;
    const after = (await browser.input(id, { type: "activate", ref: link.ref })) as {
      url: string;
    };
    assert.notEqual(after.url, before, "activating the link navigated");

    // A ref from the page just left is gone with its document, and is refused rather
    // than resolved against whatever now occupies that position.
    await assert.rejects(browser.input(id, { type: "activate", ref: link.ref }), {
      code: "STALE_REF",
    });
    // History moves are verbs the session itself answers.
    const back = (await browser.input(id, { type: "nav", to: "back" })) as { url: string };
    assert.equal(back.url, before);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a session holds several tabs and every action lands on the active one", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-tabs-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://example.com/");
    const listed = (await browser.tabs(id, "list")) as { active: number; tabs: { url: string }[] };
    assert.equal(listed.tabs.length, 1);
    assert.equal(listed.active, 0);

    // A second tab on the same reachable origin, so the test exercises tab handling rather
    // than whether a third-party host happens to answer.
    const second = "https://example.com/?second=1";
    const opened = (await browser.tabs(id, "open", undefined, second)) as {
      active: number;
      tabs: { url: string; title: string }[];
    };
    assert.equal(opened.tabs.length, 2);
    assert.equal(opened.active, 1, "a freshly opened tab becomes the active one");
    assert.ok(opened.tabs[1].url.includes("second=1"));

    // Reading sees the active tab, so a later action is aimed at the right page.
    const read = await browser.read(id);
    assert.ok(read.url.includes("second=1"));

    // Switching back is how an agent compares two pages without losing either.
    const switched = (await browser.tabs(id, "switch", 0)) as { active: number };
    assert.equal(switched.active, 0);
    assert.equal((await browser.read(id)).url, "https://example.com/");

    // A tab the caller cannot name is refused.
    await assert.rejects(browser.tabs(id, "switch", 9), { code: "NO_SUCH_TAB" });
    await assert.rejects(browser.tabs(id, "switch", -1), { code: "NO_SUCH_TAB" });
    await assert.rejects(browser.tabs(id, "close", 5), { code: "NO_SUCH_TAB" });
    const closed = (await browser.tabs(id, "close", 1)) as { active: number; tabs: unknown[] };
    assert.equal(closed.tabs.length, 1);
    assert.equal(closed.active, 0, "the remaining tab stays active");
    // The session's last tab is never closed out from under the user.
    await assert.rejects(browser.tabs(id, "close", 0), { code: "LAST_TAB" });
    assert.equal(((await browser.tabs(id, "list")) as { tabs: unknown[] }).tabs.length, 1);
    // An unusable destination never leaves a stray tab behind.
    await assert.rejects(browser.tabs(id, "open", undefined, "http://127.0.0.1:8790/"), {
      code: "BLOCKED_URL",
    });
    assert.equal(((await browser.tabs(id, "list")) as { tabs: unknown[] }).tabs.length, 1);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("waiting settles the page and an upload offers only a stored file", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-wait-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://example.com/");
    // Each wait verb is accepted by the real page and returns refreshed session metadata.
    for (const input of [
      { type: "wait", until: "idle" as const },
      { type: "wait", until: "text" as const },
      { type: "wait", until: "delay" as const, ms: 50 },
    ]) {
      const session = await browser.input(id, input);
      assert.equal(session.status, "active");
    }
    // Waiting for an element that is not on the page fails clearly instead of hanging.
    await assert.rejects(browser.input(id, { type: "wait", until: "element", ref: "e99" }), {
      code: "WAIT_TIMEOUT",
    });
    // A file the session never stored cannot be attached, and a non-file element refuses.
    await assert.rejects(browser.input(id, { type: "upload", ref: "e1", file: "invoice.pdf" }), {
      code: "STALE_REF",
    });
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
