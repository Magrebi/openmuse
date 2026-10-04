import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { excerptAround, messageText, searchConversations } from "../apps/server/src/chat-search.ts";

const text = (value: string) => ({ type: "text", text: value });

/** A stand-in for the platform client: thread list plus per-thread transcripts. */
function platform(threads: Record<string, { name: string | null; messages: unknown[] }>) {
  const listThreads = async () => ({
    threads: Object.entries(threads).map(([id, value]) => ({
      id,
      name: value.name,
      lastRunAt: "2026-01-01T00:00:00.000Z",
    })),
    joinCode: "j",
    token: "t",
  });
  const getThreadMessages = async ({ threadId }: { threadId: string }) => ({
    messages: threads[threadId]?.messages ?? [],
  });
  return { listThreads, getThreadMessages } as unknown as CopilotKitIntelligence;
}

test("message text is read from AG-UI parts and ignores everything else", () => {
  assert.equal(
    messageText({ parts: [text("hello"), { type: "image" }, text("world")] }),
    "hello\nworld",
  );
  assert.equal(messageText("plain"), "plain");
  // Unknown shapes contribute nothing rather than throwing or printing [object Object].
  assert.equal(messageText({ parts: [{ type: "tool_use" }] }), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText({ parts: "not-an-array" }), "");
});

test("an excerpt keeps the match in view and is length-bounded", () => {
  const long = `${"x".repeat(400)} needle ${"y".repeat(400)}`;
  const excerpt = excerptAround(long, "needle");
  assert.ok(excerpt.includes("needle"), "the match must be visible");
  assert.ok(excerpt.length <= 201, `excerpt was ${excerpt.length} chars`);
  assert.ok(excerpt.startsWith("…"), "a clipped window is marked as clipped");
});

test("search finds a message in one chat and names the chat it came from", async () => {
  const hits = await searchConversations(
    platform({
      "chat-a": {
        name: "Kitchen renovation",
        messages: [{ role: "user", content: { parts: [text("the tiles arrive on friday")] } }],
      },
      "chat-b": {
        name: "Tax",
        messages: [{ role: "user", content: { parts: [text("unrelated")] } }],
      },
    }),
    "owner",
    "tiles",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].threadId, "chat-a");
  assert.equal(hits[0].threadName, "Kitchen renovation");
  assert.ok(hits[0].excerpt.includes("tiles"));
});

test("a hit never carries content from a chat the query did not match", async () => {
  // Cross-chat leakage guard: chat-b's text must not appear in a chat-a result.
  const hits = await searchConversations(
    platform({
      "chat-a": {
        name: "A",
        messages: [{ role: "user", content: { parts: [text("deck outline")] } }],
      },
      "chat-b": {
        name: "B",
        messages: [{ role: "user", content: { parts: [text("bank secret sauce")] } }],
      },
    }),
    "owner",
    "deck",
  );
  assert.equal(hits.length, 1);
  assert.ok(!JSON.stringify(hits).includes("sauce"), "another chat's text leaked into the result");
});

test("a chat named with the query is found even when no message matches", async () => {
  const hits = await searchConversations(
    platform({ "chat-a": { name: "Mortgage refinance", messages: [] } }),
    "owner",
    "mortgage",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].role, "name");
});

test("a one-character query returns nothing rather than the whole account", async () => {
  let called = false;
  const client = {
    listThreads: async () => {
      called = true;
      return { threads: [] };
    },
  } as unknown as CopilotKitIntelligence;
  assert.deepEqual(await searchConversations(client, "owner", "a"), []);
  assert.equal(called, false, "the platform should not be queried for a trivial search");
});

test("one unreadable transcript does not fail the whole search", async () => {
  const client = {
    listThreads: async () => ({
      threads: [
        { id: "broken", name: null, lastRunAt: "2026-01-01T00:00:00.000Z" },
        { id: "good", name: null, lastRunAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
    getThreadMessages: async ({ threadId }: { threadId: string }) => {
      if (threadId === "broken") throw new Error("transcript unavailable");
      return { messages: [{ role: "user", content: { parts: [text("findable")] } }] };
    },
  } as unknown as CopilotKitIntelligence;
  const hits = await searchConversations(client, "owner", "findable");
  assert.deepEqual(
    hits.map((hit) => hit.threadId),
    ["good"],
  );
});
