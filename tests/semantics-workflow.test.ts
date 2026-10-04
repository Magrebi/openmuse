import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { Idea } from "../packages/domain/src/agent.ts";
import type { CalendarEvent, Mail } from "../packages/domain/src/index.ts";

/**
 * The semantic scanner, exercised through the real service.
 *
 * The unit tests in `semantics.test.ts` prove the correlator works on inputs.
 * These prove it is actually *wired in* — that `refreshIdeas` calls it, that the
 * records it reads are the ones a person would see, and that what it produces
 * survives the same retire-and-deduplicate rules as every other idea. A
 * correlator that works and is never called is not a feature.
 */

const config = (dir: string) => ({
  mode: "sample" as const,
  port: 0,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: dir,
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  agentBackend: "sample" as const,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
  casaosApiUrl: "http://127.0.0.1",
  casaosProtectedApps: ["openmuse", "tailscale", "casaos"],
  casaosSelfApps: [],
  casaosLogToModel: false,
  intelligenceApiKey: "test-key",
});

async function withServer<T>(
  run: (
    server: Awaited<ReturnType<typeof createApp>> & { db: Awaited<ReturnType<typeof createStore>> },
  ) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-semantics-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const app = await createApp(db, config(directory));
  try {
    return await run({ ...app, db });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const mail = (over: Partial<Mail>): Mail => ({
  id: "m1",
  threadId: "t1",
  from: "airline@example.com",
  sender: "The Airline",
  to: ["alex@example.com"],
  subject: "Subject",
  body: "",
  date: new Date().toISOString(),
  unread: false,
  label: "Work",
  attachments: [],
  ...over,
});

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e1",
  calendarId: "primary",
  title: "Dinner with Maya",
  start: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  end: new Date(Date.now() + 7 * 3_600_000).toISOString(),
  allDay: false,
  timeZone: "UTC",
  location: "",
  description: "",
  attendees: [],
  ...over,
});

/** A delay email and a dinner with the same person, six hours out. */
const seedDelay = async (db: Awaited<ReturnType<typeof createStore>>, owner: string) => {
  await db.put(owner, "settings", { id: "google", enabled: true });
  await db.put(
    owner,
    "mail",
    mail({
      id: "delay",
      subject: "Flight update",
      body: "Your flight is delayed until late evening.",
      to: ["alex@example.com", "maya@example.com"],
    }),
  );
  await db.put(owner, "events", event({ id: "dinner", attendees: ["maya@example.com"] }));
};

test("a delay that affects a booked evening is surfaced as one idea naming both", async () => {
  await withServer(async ({ db, agent }) => {
    const owner = "local-user";
    await seedDelay(db, owner);
    const ideas = await agent.refreshIdeas(owner);
    const found = ideas.find((idea) => idea.input.key === "disruption:delay:dinner");
    assert.ok(found, `no disruption idea: ${JSON.stringify(ideas.map((i) => i.input))}`);
    assert.match(found.title, /Dinner with Maya/);
    assert.match(found.reason, /Dinner with Maya/);
    assert.match(found.reason, /hours/, "the reason must say how soon");
    assert.equal(found.status, "new");
    assert.equal(found.evidence.length, 1, "the source email must be cited");
    assert.equal(found.evidence[0].id, "delay");
    assert.match(found.prompt, /Ask me before contacting anyone/);
  });
});

test("the same pairing is never offered twice across scans", async () => {
  await withServer(async ({ db, agent }) => {
    const owner = "local-user";
    await seedDelay(db, owner);
    const first = await agent.refreshIdeas(owner);
    const second = await agent.refreshIdeas(owner);
    const count = (list: Idea[]) =>
      list.filter((idea) => idea.input.key === "disruption:delay:dinner").length;
    assert.equal(count(first), 1);
    assert.equal(count(second), 1, "a second scan must not duplicate an existing idea");
    assert.equal(
      (await db.list<Idea>(owner, "ideas")).filter(
        (idea) => idea.input.key === "disruption:delay:dinner",
      ).length,
      1,
    );
  });
});

test("a pairing whose email has been answered is retired like any other idea", async () => {
  await withServer(async ({ db, agent }) => {
    const owner = "local-user";
    await seedDelay(db, owner);
    const before = await agent.refreshIdeas(owner);
    const idea = before.find((i) => i.input.key === "disruption:delay:dinner");
    assert.ok(idea);
    // The person answers it themselves, so the suggestion is no longer useful.
    // Relabelling the source as Sent is how a reply appears in a synced mailbox.
    await db.put(
      owner,
      "mail",
      mail({
        id: "delay",
        subject: "Flight update",
        body: "Your flight is delayed until late evening.",
        to: ["alex@example.com", "maya@example.com"],
        label: "Sent",
      }),
    );
    const after = await agent.refreshIdeas(owner);
    assert.equal(
      after.find((i) => i.id === idea.id)?.status,
      "dismissed",
      "an answered email must retire its suggestion",
    );
  });
});

test("an unrelated inbox produces no cross-source ideas at all", async () => {
  await withServer(async ({ db, agent }) => {
    const owner = "local-user";
    await db.put(owner, "settings", { id: "google", enabled: true });
    await db.put(
      owner,
      "mail",
      mail({ id: "news", subject: "Weekly newsletter", body: "Read our latest stories." }),
    );
    await db.put(owner, "events", event({ id: "dinner", attendees: ["maya@example.com"] }));
    const ideas = await agent.refreshIdeas(owner);
    assert.equal(
      ideas.filter((idea) => typeof idea.input.key === "string").length,
      0,
      `unexpected pairings: ${JSON.stringify(ideas.map((i) => i.input))}`,
    );
  });
});

test("an owner with no mailbox at all gets no ideas and no error", async () => {
  await withServer(async ({ agent }) => {
    assert.deepEqual(await agent.refreshIdeas("empty-owner"), []);
  });
});
