import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import type { ActionProposal, Artifact, Workspace } from "../packages/domain/src/index.ts";

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  agent: AgentService,
  config: Config,
  token: string,
  directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-api-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app, agent } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("expired sessions are collected instead of accumulating forever", async () => {
  // Nothing in the app used to delete a session row, so every sign-in left a
  // bearer-token digest behind permanently, long past its 24 hour expiry.
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const dead = "a-token-that-expired-yesterday";
  await db.put("system", "sessions", {
    id: digest(dead),
    owner: "local-user",
    expiresAt: Date.now() - 1,
  });

  const signIn = async () => {
    const response = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    return (await response.json()).token as string;
  };
  const fresh = await signIn();

  assert.ok(
    !(await db.get("system", "sessions", digest(dead))),
    "signing in collects sessions that already lapsed",
  );
  assert.ok(await db.get("system", "sessions", digest(fresh)), "the session just created is kept");
  assert.equal(
    (await app.request("/api/workspace", { headers: { Authorization: `Bearer ${fresh}` } })).status,
    200,
    "and still authenticates",
  );

  // Presenting a lapsed token stays a 401, and now also drops the row.
  await db.put("system", "sessions", {
    id: digest(dead),
    owner: "local-user",
    expiresAt: Date.now() - 1,
  });
  assert.equal(
    (await app.request("/api/workspace", { headers: { Authorization: `Bearer ${dead}` } })).status,
    401,
  );
  assert.ok(!(await db.get("system", "sessions", digest(dead))), "a rejected token leaves no row");
});

test("API protects private data and rejects unrelated web origins", async () => {
  assert.equal((await app.request("/api/workspace")).status, 401);
  assert.equal(
    (
      await app.request("/api/workspace", {
        headers: { ...headers(), Origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
});
test("sample workspace serves a real PDF and filling creates a new version", async () => {
  const response = await app.request("/api/workspace", { headers: headers() });
  assert.equal(response.status, 200);
  const workspace: Workspace = await response.json();
  assert.equal(workspace.mode, "sample");
  assert.equal(workspace.mail.length, 4);
  const original = workspace.files[0];
  assert.equal(original.pageCount, 2);
  const signed = await app.request(original.url);
  assert.equal(signed.headers.get("content-type"), "application/pdf");
  const bytes = new Uint8Array(await signed.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const fill = await app.request(`/api/files/${original.id}/fill`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      fields: { participant_name: "Sample Student", permission_granted: true },
    }),
  });
  assert.equal(fill.status, 201);
  const output: Artifact = await fill.json();
  assert.notEqual(output.id, original.id);
  assert.equal(output.parentId, original.id);
  assert.equal(output.fields?.find((f) => f.name === "participant_name")?.value, "Sample Student");
  const unchanged = await app.request(original.url);
  assert.deepEqual(new Uint8Array(await unchanged.arrayBuffer()), bytes);
  const forged = new URL(original.url);
  forged.searchParams.set("owner", "another-user");
  assert.equal((await app.request(forged.toString())).status, 403);
});
test("reviewed sample email persists a receipt, then revocation blocks another proposal", async () => {
  const propose = () =>
    app.request("/api/actions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind: "email.send",
        data: {
          to: ["sample@example.com"],
          subject: "Permission slip",
          body: "Here is the sample form.",
        },
      }),
    });
  const proposal: ActionProposal = await (await propose()).json();
  assert.equal(proposal.status, "awaiting_review");
  const denied = await app.request(`/api/actions/${proposal.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, decision: "deny" }),
  });
  assert.equal((await denied.json()).status, "denied");
  const approved: ActionProposal = await (await propose()).json();
  const result = await app.request(`/api/actions/${approved.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: approved.hash, decision: "approve" }),
  });
  const saved: ActionProposal = await result.json();
  assert.equal(saved.status, "succeeded");
  assert.match(saved.result ?? "", /local sent mail/);
  const pending: ActionProposal = await (await propose()).json();
  await app.request("/api/google/disconnect", { method: "POST", headers: headers(), body: "{}" });
  const revoked = await app.request(`/api/actions/${pending.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: pending.hash, decision: "approve" }),
  });
  assert.equal(revoked.status, 409);
});
test("missing browser setup is explicit rather than a fictional browser session", async () => {
  const response = await app.request("/api/browsers", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});
test("calendar ranges and complete sample mail threads survive navigation", async () => {
  await app.request("/api/google/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ capability: "read" }),
  });
  const calendars = await app.request("/api/calendars", { headers: headers() });
  assert.equal((await calendars.json())[0].id, "primary");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const next = new Date(tomorrow.getTime() + 86400000);
  const range = new URLSearchParams({
    timeMin: tomorrow.toISOString(),
    timeMax: next.toISOString(),
    calendarId: "primary",
  });
  const events = await app.request(`/api/calendar/events?${range}`, { headers: headers() });
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), []);
  const thread = await app.request("/api/mail/threads/trip-thread", { headers: headers() });
  assert.equal(thread.status, 200);
  assert.equal((await thread.json())[0].id, "mail-fieldtrip");
  const invalid = await app.request(
    "/api/calendar/events?timeMin=2026-09-20T00:00:00Z&timeMax=2026-09-19T00:00:00Z",
    { headers: headers() },
  );
  assert.equal(invalid.status, 422);
});
function sampleRun(threadId: string, runId: string, messageId: string, content: string) {
  return new ConversationAgent(config, agent, "local-user").run({
    threadId,
    runId,
    messages: [{ id: messageId, role: "user", content }],
    tools: [],
    context: [],
    state: {},
  });
}

test("sample agent streams actual AG-UI events without a model key", async () => {
  const info = await app.request("/api/copilotkit/info", { headers: headers() });
  assert.equal(info.status, 200);
  const stream = JSON.stringify(
    await lastValueFrom(
      sampleRun("sample-test", "sample-run", "message1", "Show my calendar").pipe(toArray()),
    ),
  );
  assert.match(stream, /RUN_STARTED/);
  assert.match(stream, /TEXT_MESSAGE_CONTENT/);
  assert.match(stream, /RUN_FINISHED/);
  assert.match(stream, /Your local calendar has/);
});

test("guided document delegation streams a rich tool result bound to its saved task", async () => {
  const events = await lastValueFrom(
    sampleRun(
      "document-thread",
      "document-run",
      "document-request",
      "Complete the permission slip",
    ).pipe(toArray()),
  );
  const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(start?.toolCallName, "delegate_task");
  assert.equal(result?.toolCallId, start?.toolCallId);
  assert.ok(result && typeof result.content === "string");
  const { id } = JSON.parse(result.content);
  const task = await db.get<{ input: { messageId: string }; kind: string }>(
    "local-user",
    "tasks",
    id,
  );
  assert.equal(task?.kind, "document");
  assert.equal(task?.input.messageId, "mail-fieldtrip");
});

/** Propose an email through the API, the way the agent would. */
async function proposeEmail(over: Record<string, unknown> = {}): Promise<ActionProposal> {
  const response = await app.request("/api/actions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      kind: "email.send",
      data: {
        to: ["sam@example.com"],
        cc: [],
        bcc: [],
        subject: "Visit",
        body: "See attached.",
        attachmentIds: [],
        ...over,
      },
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as ActionProposal;
}

test("an email draft can be amended in place through the API", async () => {
  const proposal = await proposeEmail();
  const response = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, data: { subject: "Visit on Saturday" } }),
  });
  assert.equal(response.status, 200);
  const amended = (await response.json()) as ActionProposal;
  assert.equal(amended.data.subject, "Visit on Saturday");
  // The new hash is what makes this a fresh thing to review rather than an edit
  // that sneaks past the thing that was reviewed.
  assert.notEqual(amended.hash, proposal.hash);
  assert.equal(amended.status, "awaiting_review");
});

test("amending requires a session", async () => {
  // The amend route writes to a proposal that leads to an outbound email, so it
  // must sit behind the same authentication as the decision it precedes.
  const proposal = await proposeEmail();
  const response = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash: proposal.hash, data: { subject: "no" } }),
  });
  assert.equal(response.status, 401);
});

test("amending with a stale hash is refused", async () => {
  const proposal = await proposeEmail();
  const first = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, data: { subject: "first" } }),
  });
  assert.equal(first.status, 200);
  const second = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, data: { subject: "second" } }),
  });
  assert.equal(second.status, 409);
});

test("an amendment cannot attach a file the owner does not have", async () => {
  // The attachment check `propose` performs has to happen here too, or editing a
  // review is a way to attach another owner's document to an outbound email.
  const proposal = await proposeEmail();
  await db.put("someone-else", "files", {
    id: "not-mine",
    name: "salary.pdf",
    mimeType: "application/pdf",
  });
  const response = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, data: { attachmentIds: ["not-mine"] } }),
  });
  assert.equal(response.status, 404);
  const saved = await db.get<ActionProposal>("local-user", "actions", proposal.id);
  assert.deepEqual(saved?.data.attachmentIds, [], "the rejected attachment must not be stored");
});

test("an amendment cannot change the kind of action", async () => {
  const proposal = await proposeEmail();
  const response = await app.request(`/api/actions/${proposal.id}/amend`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      hash: proposal.hash,
      data: { kind: "calendar.delete", eventId: "e1", calendarId: "primary", title: "x" },
    }),
  });
  assert.equal(response.status, 409);
});
