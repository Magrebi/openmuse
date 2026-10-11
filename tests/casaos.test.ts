import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createAuth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import {
  assertCasaOSAppAllowed,
  assertCasaOSUrlAllowed,
  CasaOSClient,
  capLogLines,
  clearCasaOSTokenCache,
  MAX_LINE_CHARS,
  redactCasaOSLogs,
  summarizeCasaOSLogs,
  truncateToTail,
  verifyCasaOSLogin,
} from "../apps/server/src/casaos.ts";
import {
  casaOSCredentialsConfigured,
  clearCasaOSCredentials,
  loadCasaOSCredentials,
  saveCasaOSCredentials,
} from "../apps/server/src/casaos-credentials.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { annotateCasaOSReplay, buildCasaOSTools } from "../apps/server/src/engine/model.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import type { TaskContext } from "../apps/server/src/engine/worker.ts";
import { type AppError, OutcomeUnknownError } from "../apps/server/src/errors.ts";
import { Files } from "../apps/server/src/files.ts";
import type { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

// ---------------------------------------------------------------------------
// Mock fetch: every test installs a handler; nothing here touches the network.
// Fixtures use fake values like "test-token" — never real secrets.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let fetchHandler: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
before(() => {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    if (!fetchHandler) throw new Error("fetch called without a mock handler");
    return fetchHandler(String(input), (init ?? {}) as RequestInit);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  clearCasaOSTokenCache();
});

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const appgridFixture = [
  { name: "plex", port: "32400", status: "running", image: "plexinc/pms-docker" },
  { name: "qbittorrent", port: "8080", status: "running" },
  { name: "tailscale", port: "", status: "running" },
  { name: "openmuse", port: "8081", status: "running" },
];

const composeFixture = {
  data: {
    compose: {
      services: {
        plex: {
          image: "plexinc/pms-docker:latest",
          container_name: "plex",
          environment: { PASSWORD: "hunter2", PUID: "1000", TZ: "UTC" },
        },
        qbittorrent: {
          image: "lscr.io/linuxserver/qbittorrent",
          container_name: "qbittorrent",
        },
      },
    },
  },
};

interface PutCall {
  url: string;
  body: string;
  auth: string | null;
}

interface MockState {
  logins: string[];
  puts: PutCall[];
  gets: string[];
  composePaths: string[];
  loginStatus?: number;
  putBehavior?: "ok" | "timeout" | "500";
  logsData?: string;
  /** Access token handed back by the login fixture (L4 needs a real JWT shape). */
  loginToken?: string;
}

function mockState(): MockState {
  return { logins: [], puts: [], gets: [], composePaths: [] };
}

/** Routes CasaOS API calls to fixtures; records every call for assertions. */
function casaOSMock(state: MockState) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname === "/v1/users/login" && init.method === "POST") {
      state.logins.push(headers.Authorization ?? "");
      if (state.loginStatus && state.loginStatus !== 200)
        return json(state.loginStatus, { message: "unauthorized" });
      return json(200, {
        success: 200,
        message: "ok",
        data: {
          token: { access_token: state.loginToken ?? "test-token", refresh_token: "rt" },
        },
      });
    }
    if (u.pathname === "/v2/app_management/web/appgrid") {
      state.gets.push(u.pathname);
      return json(200, { data: appgridFixture });
    }
    const statusMatch = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)\/status$/);
    if (statusMatch && init.method === "PUT") {
      state.puts.push({
        url: u.pathname,
        body: String(init.body),
        auth: headers.Authorization ?? null,
      });
      if (state.putBehavior === "timeout")
        throw new DOMException("The operation timed out", "TimeoutError");
      if (state.putBehavior === "500") return json(500, { message: "boom" });
      return json(200, { message: "compose app status is being changed asynchronously" });
    }
    const logsMatch = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)\/logs$/);
    if (logsMatch) return json(200, { data: state.logsData ?? "line1\nline2" });
    const composeMatch = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)$/);
    if (composeMatch) {
      state.composePaths.push(u.pathname);
      return json(200, composeFixture);
    }
    if (u.pathname === "/v1/sys/utilization")
      return json(200, {
        success: 200,
        message: "ok",
        data: {
          cpu: { percent: 12.5, temperature: 55 },
          mem: { usedPercent: 61.2 },
          net: { up: 1000, down: 2000 },
        },
      });
    throw new Error(`unexpected CasaOS request: ${init.method} ${u.pathname}`);
  };
}

function testClient(owner: string, connectionId = "c1") {
  return new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner,
    loadCredentials: async () => ({ username: "u", password: "p", connectionId }),
    // These tests assert on log TEXT (tail ordering, caps, redaction markers).
    // M3 makes raw text opt-in, so the shared helper enables it; the default-off
    // shape summary has its own tests below.
    logToModel: true,
  });
}

function testWorkspace(db: Store, config: Config) {
  return new WorkspaceService(db, config, {} as unknown as Files, {} as unknown as GoogleAuth);
}

// ---------------------------------------------------------------------------
// App + store for the credential-route tests.
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let token: string;
let directory: string;
let config: Config;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-casaos-"));
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
    encryptionKey: ENCRYPTION_KEY,
    casaosApiUrl: "http://127.0.0.1",
    casaosProtectedApps: ["openmuse", "tailscale", "casaos"],
    casaosSelfApps: [],
    casaosLogToModel: true,
  };
  ({ app } = await createApp(db, config));
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

// ---------------------------------------------------------------------------
// 1. Login: v1 token shape parsing, missing token, wrong password.
// ---------------------------------------------------------------------------

test("login parses the v1 token shape and rejects bad responses", async () => {
  fetchHandler = async (url, init) => {
    assert.match(url, /\/v1\/users\/login$/);
    assert.equal(init.method, "POST");
    return json(200, {
      success: 200,
      message: "ok",
      data: { token: { access_token: "test-token", refresh_token: "rt" } },
    });
  };
  assert.equal(await verifyCasaOSLogin("http://127.0.0.1", "u", "p"), "test-token");

  fetchHandler = async () => json(200, { success: 200, message: "ok", data: {} });
  await assert.rejects(() => verifyCasaOSLogin("http://127.0.0.1", "u", "p"), /access token/);

  fetchHandler = async () => json(401, { message: "unauthorized" });
  const error = await verifyCasaOSLogin("http://127.0.0.1", "u", "wrong").catch((e) => e);
  // 409, not 401: CasaOS rejected the credentials; our session is fine.
  assert.equal(error.status, 409);
  assert.match(error.message, /rejected the username or password/);
  assert.ok(!error.message.includes("wrong"));
});

// ---------------------------------------------------------------------------
// 2. App list: v2 has no success field; judge by HTTP status + data presence.
// ---------------------------------------------------------------------------

test("appgrid works without a success field and projects entries", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const apps = await testClient("t2").listApps();
  assert.deepEqual(apps, [
    { name: "plex", port: "32400", status: "running" },
    { name: "qbittorrent", port: "8080", status: "running" },
    { name: "tailscale", port: "", status: "running" },
    { name: "openmuse", port: "8081", status: "running" },
  ]);
});

// ---------------------------------------------------------------------------
// 3. 401 -> re-login once -> retry once; PUT timeout -> outcome_unknown, no retry,
//    exact raw-string body.
// ---------------------------------------------------------------------------

test("401 re-logs in once and retries once; PUT timeout is outcome_unknown", async () => {
  const state = mockState();
  state.putBehavior = "timeout";
  let appgridCalls = 0;
  fetchHandler = async (url, init) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname === "/v1/users/login") {
      state.logins.push(headers.Authorization ?? "");
      const fresh = appgridCalls > 0;
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: fresh ? "fresh-token" : "stale-token" } },
      });
    }
    if (u.pathname === "/v2/app_management/web/appgrid") {
      appgridCalls += 1;
      if (appgridCalls === 1) return json(401, { message: "unauthorized" });
      return json(200, { data: appgridFixture });
    }
    const match = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)\/status$/);
    if (match && init.method === "PUT") {
      state.puts.push({
        url: u.pathname,
        body: String(init.body),
        auth: headers.Authorization ?? null,
      });
      throw new DOMException("The operation timed out", "TimeoutError");
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const client = testClient("t3");
  const apps = await client.listApps();
  assert.equal(apps.length, 4);
  assert.equal(state.logins.length, 2); // initial login + one re-login
  assert.equal(appgridCalls, 2); // 401, then exactly one retry

  await assert.rejects(client.setAppStatus("plex", "stop"), OutcomeUnknownError);
  assert.equal(state.puts.length, 1); // no retry on timeout
  assert.equal(state.puts[0].body, '"stop"'); // raw JSON string, not an object
  assert.equal(state.puts[0].auth, "fresh-token"); // raw JWT, no Bearer prefix
});

test("PUT 5xx is outcome_unknown without retry", async () => {
  const state = mockState();
  state.putBehavior = "500";
  fetchHandler = casaOSMock(state);
  await assert.rejects(testClient("t3b").setAppStatus("plex", "restart"), OutcomeUnknownError);
  assert.equal(state.puts.length, 1);
  assert.equal(state.puts[0].body, '"restart"');
});

// ---------------------------------------------------------------------------
// 4. App validation: strict pattern + appgrid membership.
// ---------------------------------------------------------------------------

test("app names are validated against a strict pattern and appgrid membership", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const client = testClient("t4");
  await assert.rejects(() => client.validateApp("../x"), /Unknown CasaOS app/);
  await assert.rejects(() => client.validateApp("plex/../../v1"), /Unknown CasaOS app/);
  await assert.rejects(() => client.validateApp("PLEX"), /Unknown CasaOS app/);
  await assert.rejects(() => client.validateApp("nope"), /not installed/);
  assert.equal(await client.validateApp("qbittorrent"), "qbittorrent");
});

// ---------------------------------------------------------------------------
// 5. Compose projection: no environment/secrets; appgrid name -> compose path.
// ---------------------------------------------------------------------------

test("compose projection never includes environment secrets", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const client = testClient("t5");
  const services = await client.appServices("plex");
  assert.deepEqual(services, [
    { service: "plex", image: "plexinc/pms-docker:latest", container_name: "plex" },
    {
      service: "qbittorrent",
      image: "lscr.io/linuxserver/qbittorrent",
      container_name: "qbittorrent",
    },
  ]);
  assert.ok(!JSON.stringify(services).includes("hunter2"));

  // Live-style fixture: the appgrid name maps to the compose path.
  const detail = await client.getApp("qbittorrent");
  assert.equal(detail.name, "qbittorrent");
  assert.equal(detail.port, "8080");
  assert.equal(detail.status, "running");
  assert.ok(state.composePaths.includes("/v2/app_management/compose/qbittorrent"));
});

// ---------------------------------------------------------------------------
// 6. Log redaction + 8KB truncation.
// ---------------------------------------------------------------------------

test("log redaction scrubs secrets best-effort", () => {
  const dirty = [
    "Authorization: Bearer abcdef123456",
    "token=sk-abc123XYZ789",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    "connecting to https://admin:s3cr3t@db.internal:5432/app",
    "password=hunter2",
    "plain line stays",
  ].join("\n");
  const clean = redactCasaOSLogs(dirty);
  for (const secret of [
    "abcdef123456",
    "sk-abc123XYZ789",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    "s3cr3t",
    "hunter2",
  ])
    assert.ok(!clean.includes(secret), `leaked: ${secret}`);
  assert.ok(clean.includes("plain line stays"));
  assert.ok(clean.includes("[redacted"));
});

test("appLogs caps output at an 8KB tail", async () => {
  const state = mockState();
  state.logsData = Array.from(
    { length: 5000 },
    (_, i) => `log line ${i} with padding xxxxxxxxxx`,
  ).join("\n");
  fetchHandler = casaOSMock(state);
  const client = testClient("t6");
  const result = await client.appLogs("plex");
  const bytes = Buffer.byteLength(result.lines.join("\n"), "utf8");
  assert.ok(bytes <= 8192, `log output too big: ${bytes} bytes`);
  assert.equal(result.truncated, true);
  assert.equal(result.redacted, true);
  assert.ok(result.lines[result.lines.length - 1].includes("log line 4999")); // tail kept
  const tailed = await client.appLogs("plex", 5);
  assert.equal(tailed.lines.length, 5);
  assert.ok(tailed.lines[4].includes("log line 4999"));
});

// ---------------------------------------------------------------------------
// 7. Approval gating: no PUT before approval, exactly one PUT after, frozen args,
//    server-generated title, outcome_unknown on ambiguity.
// ---------------------------------------------------------------------------

function casaOSActions(db: Store, workspace: WorkspaceService) {
  let executeCalls = 0;
  let executedInput: unknown = null;
  const service = new ActionService(db, {
    execute: async (owner, input, connectionId) => {
      executeCalls += 1;
      executedInput = input;
      return workspace.execute(owner, input, connectionId);
    },
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner, kind) =>
      kind === "casaos.action" ? workspace.casaOSConnected(owner) : Promise.resolve(false),
    connection: (owner, kind) =>
      kind === "casaos.action" ? workspace.casaOSConnection(owner) : Promise.resolve(null),
  });
  return { service, calls: () => executeCalls, input: () => executedInput };
}

test("mutations need approval: no PUT before, exactly one PUT after, frozen args", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t7";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service, calls, input } = casaOSActions(db, workspace);

  const proposal = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "stop", note: "model note here" } },
    "t7:task:1",
  );
  assert.equal(proposal.status, "awaiting_review");
  assert.equal(proposal.title, "Stop plex on CasaOS"); // server-generated, not model text
  assert.equal(state.puts.length, 0); // nothing executed before approval

  const decided = await service.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.equal(calls(), 1);
  assert.equal(state.puts.length, 1); // exactly one PUT after approval
  assert.ok(state.puts[0].url.endsWith("/v2/app_management/compose/plex/status"));
  assert.equal(state.puts[0].body, '"stop"');
  // Frozen args: the executor used the review record; the note never reached CasaOS.
  assert.deepEqual(input(), {
    kind: "casaos.action",
    data: { app: "plex", action: "stop", note: "model note here" },
  });

  // A second decision on the same proposal cannot execute again.
  const again = await service.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(again.status, "succeeded");
  assert.equal(calls(), 1);
  assert.equal(state.puts.length, 1);
});

test("ambiguous PUT outcome is recorded as outcome_unknown", async () => {
  const state = mockState();
  state.putBehavior = "timeout";
  fetchHandler = casaOSMock(state);
  const owner = "t7b";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service } = casaOSActions(db, workspace);
  const proposal = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "restart" } },
    "t7b:task:1",
  );
  const decided = await service.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "outcome_unknown");
  assert.match(decided.error ?? "", /may or may not have happened/);
});

// ---------------------------------------------------------------------------
// 8. Protection list: proposal-time and execution-time.
// ---------------------------------------------------------------------------

test("protection list rejects at proposal time and at execution time", async () => {
  const list = ["openmuse", "tailscale", "casaos"];
  assert.throws(() => assertCasaOSAppAllowed(list, "openmuse"), /protected/);
  assert.throws(() => assertCasaOSAppAllowed(list, "OpenMuse"), /protected/); // case-insensitive
  assert.throws(() => assertCasaOSAppAllowed(list, "tailscale"), /protected/);
  assert.throws(() => assertCasaOSAppAllowed(list, "openmuse-api-1"), /protected/); // prefix
  assert.throws(() => assertCasaOSAppAllowed(list, "OpenMuse-Browser-Worker-1"), /protected/);
  assert.doesNotThrow(() => assertCasaOSAppAllowed(list, "plex"));
  // The prefix rejection is a 403 (protected), not a 404 (unknown app).
  const prefixError = (() => {
    try {
      assertCasaOSAppAllowed(list, "openmuse-api-1");
    } catch (e) {
      return e;
    }
    return null;
  })() as { status?: number } | null;
  assert.equal(prefixError?.status, 403);

  const workspace = testWorkspace(db, config);
  await assert.rejects(
    () =>
      workspace.prepare("t8", {
        kind: "casaos.action",
        data: { app: "openmuse", action: "restart" },
      }),
    /protected/,
  );

  const state = mockState();
  fetchHandler = casaOSMock(state);
  clearCasaOSTokenCache("t8exec");
  await saveCasaOSCredentials(db, config, "t8exec", "admin", "right-password");
  await assert.rejects(
    () =>
      testWorkspace(db, config).execute(
        "t8exec",
        { kind: "casaos.action", data: { app: "tailscale", action: "stop" } },
        "conn-1",
      ),
    /protected/,
  );
  assert.equal(state.puts.length, 0);
});

// ---------------------------------------------------------------------------
// 9. Disconnect: credentials gone, token cache cleared, reviews invalidated.
// ---------------------------------------------------------------------------

test("disconnect clears credentials, token cache and invalidates reviews", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t9";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  assert.equal(await casaOSCredentialsConfigured(db, config, owner), true);

  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner,
    loadCredentials: () => loadCasaOSCredentials(db, config, owner),
  });
  await client.listApps();
  assert.equal(state.logins.length, 2); // save-time login + first client login
  clearCasaOSTokenCache(owner);
  // Fresh client: the first client's 8s appgrid cache would otherwise serve
  // listApps without a network call (and thus without a login).
  const client2 = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner,
    loadCredentials: () => loadCasaOSCredentials(db, config, owner),
  });
  await client2.listApps();
  assert.equal(state.logins.length, 3); // cache cleared -> fresh login

  const workspace = testWorkspace(db, config);
  const { service } = casaOSActions(db, workspace);
  const proposal = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "restart" } },
    "t9:task:1",
  );
  assert.equal(proposal.status, "awaiting_review");
  await clearCasaOSCredentials(db, owner);
  assert.equal(await casaOSCredentialsConfigured(db, config, owner), false);
  await assert.rejects(
    () => service.decide(owner, proposal.id, proposal.hash, "approve"),
    /disconnected|changed/,
  );
});

test("corrupt credential records read as not configured", async () => {
  await db.put("t9corrupt", "credentials", {
    id: "casaos",
    connectionId: "x",
    secret: "not-encrypted",
  });
  assert.equal(await casaOSCredentialsConfigured(db, config, "t9corrupt"), false);
  assert.equal(await loadCasaOSCredentials(db, config, "t9corrupt"), null);
});

// ---------------------------------------------------------------------------
// 10. Credential routes: lifecycle, 422/409/503, GET leaks nothing, rate limit.
// ---------------------------------------------------------------------------

test("credential lifecycle over HTTP", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);

  let response = await app.request("/api/casaos/credentials", { headers: headers() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false });

  response = await app.request("/api/casaos/credentials", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "admin", password: "right-password" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { configured: true });

  response = await app.request("/api/casaos/credentials", { headers: headers() });
  assert.deepEqual(await response.json(), { configured: true }); // no username/password keys

  response = await app.request("/api/casaos/credentials", {
    method: "DELETE",
    headers: headers(),
  });
  assert.equal(response.status, 200);
  response = await app.request("/api/casaos/credentials", { headers: headers() });
  assert.deepEqual(await response.json(), { configured: false });

  response = await app.request("/api/casaos/credentials", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "", password: "x" }),
  });
  assert.equal(response.status, 422);
});

test("wrong password is a 409 (never our 401) and stores nothing", async () => {
  const state = mockState();
  state.loginStatus = 401;
  fetchHandler = casaOSMock(state);
  const response = await app.request("/api/casaos/credentials", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "admin", password: "wrong-password" }),
  });
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes("wrong-password"));
  const check = await app.request("/api/casaos/credentials", { headers: headers() });
  assert.deepEqual(await check.json(), { configured: false });
});

test("saving without TOKEN_ENCRYPTION_KEY is a 503", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const second = await createApp(db, { ...config, encryptionKey: undefined });
  const response = await second.app.request("/api/casaos/credentials", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "admin", password: "right-password" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /TOKEN_ENCRYPTION_KEY/);
});

test("credential saves are rate limited", async () => {
  const state = mockState();
  state.loginStatus = 401;
  fetchHandler = casaOSMock(state);
  let limitedAt = -1;
  for (let i = 0; i < 8; i += 1) {
    const response = await app.request("/api/casaos/credentials", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ username: "admin", password: `wrong-${i}` }),
    });
    if (response.status === 429) {
      limitedAt = i;
      break;
    }
    assert.equal(response.status, 409);
  }
  assert.ok(limitedAt >= 0 && limitedAt <= 5, `rate limited at attempt ${limitedAt}`);
});

// ---------------------------------------------------------------------------
// 11. The password never appears in responses, logs or errors.
// ---------------------------------------------------------------------------

test("the password never appears in responses, logs or errors", async () => {
  const password = "s3cr3t-pw-never-log";
  const seen: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    const state = mockState();
    state.loginStatus = 401;
    fetchHandler = casaOSMock(state);
    const response = await app.request("/api/casaos/credentials", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ username: "admin", password }),
    });
    // Status may be 409 (bad password) or 429 (rate limit from earlier tests);
    // either way the body must never contain the password.
    assert.ok([409, 429].includes(response.status), `unexpected status ${response.status}`);
    assert.ok(!(await response.text()).includes(password));

    const saveError = await saveCasaOSCredentials(db, config, "t11", "admin", password).catch(
      (e: unknown) => e,
    );
    assert.ok(
      !String(saveError instanceof Error ? saveError.message : saveError).includes(password),
    );

    const loginError = await verifyCasaOSLogin("http://127.0.0.1", "admin", password).catch(
      (e: unknown) => e,
    );
    assert.ok(
      !String(loginError instanceof Error ? loginError.message : loginError).includes(password),
    );
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  assert.ok(!seen.join("\n").includes(password), "password leaked into console output");
});

// ---------------------------------------------------------------------------
// 12. Fix round: terminal records are never replayed; task-scoped proposals.
// ---------------------------------------------------------------------------

test("terminal casaos records are never replayed: re-propose creates a fresh review", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service } = casaOSActions(db, workspace);

  const data = { kind: "casaos.action", data: { app: "handbrake", action: "stop" } } as const;
  const first = await service.propose(owner, data, "t12:task:1");
  assert.equal(first.status, "awaiting_review");
  const denied = await service.decide(owner, first.id, first.hash, "deny");
  assert.equal(denied.status, "denied");

  // Same idempotency key, but the old record is terminal: a fresh review.
  const second = await service.propose(owner, data, "t12:task:1");
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "awaiting_review");

  // A succeeded record is not replayed either (plex validates end-to-end).
  const ok = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "stop" } },
    "t12:task:2",
  );
  const done = await service.decide(owner, ok.id, ok.hash, "approve");
  assert.equal(done.status, "succeeded");
  const retry = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "stop" } },
    "t12:task:2",
  );
  assert.notEqual(retry.id, ok.id);
  assert.equal(retry.status, "awaiting_review");
});

test("same casaos action in two tasks creates two independent reviews", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12b";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service } = casaOSActions(db, workspace);

  const data = { kind: "casaos.action", data: { app: "plex", action: "stop" } } as const;
  const one = await service.propose(owner, data, "t12b:task:A");
  const two = await service.propose(owner, data, "t12b:task:B");
  assert.notEqual(one.id, two.id);
  assert.equal(one.status, "awaiting_review");
  assert.equal(two.status, "awaiting_review");
});

// ---------------------------------------------------------------------------
// 12b. Fix round 8: post-approval continuation must not open a second review.
// Simulates the full production path: the tool handler calls
// AgentService.prepareCasaOSAction, the user approves via actions.decide
// (which executes the PUT), then the resumed task's model re-proposes the
// same action with the same taskId and idempotency key.
// ---------------------------------------------------------------------------

test("post-approval re-proposal replays the recorded result instead of opening a second review", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12c";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service: actions, calls } = casaOSActions(db, workspace);
  const auth = await createAuth(db, config);
  const files = new Files(db, config, auth);
  const browser = new BrowserService(db, config, auth, files);
  const agent = new AgentService(db, config, workspace, files, actions, browser);

  const taskId = "t12c:task:1";
  await db.put(owner, "tasks", { id: taskId, status: "waiting_approval" });
  const task = { id: taskId } as unknown as AgentTask;
  const ctx = {
    guard: async () => {},
    checkpoint: async (patch: unknown) => patch,
    event: async () => {},
  } as unknown as TaskContext;
  // Same key derivation as the casaos_restart_app tool handler (engine/model.ts).
  const key = createHash("sha256")
    .update(JSON.stringify({ kind: "casaos.action", app: "plex", action: "restart", taskId }))
    .digest("hex");

  // 1. The model proposes "restart plex".
  const first = await agent.prepareCasaOSAction(
    owner,
    task,
    { app: "plex", action: "restart" },
    key,
    ctx,
  );
  assert.equal(first.status, "awaiting_review");

  // 2. The user approves in the UI; the PUT executes exactly once.
  const decided = await actions.decide(owner, first.id, first.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.equal(state.puts.length, 1);

  // 3. The task continues and the model re-proposes the same action
  //    (same taskId, same idempotency key).
  const second = await agent.prepareCasaOSAction(
    owner,
    task,
    { app: "plex", action: "restart" },
    key,
    ctx,
  );

  // 4. No second review may open: the recorded success replays, so a resumed
  //    task can never spin an approval loop.
  assert.equal(second.id, first.id, "re-proposal must replay, not open a new review");
  assert.equal(second.status, "succeeded");
  assert.equal(calls(), 1, "execute must not run again");
  assert.equal(state.puts.length, 1, "no second PUT");
  const awaiting = (await db.scan<{ status: string }>("actions")).filter(
    (r) => r.owner === owner && r.value.status === "awaiting_review",
  );
  assert.equal(awaiting.length, 0, "no second awaiting_review record");
});

// ---------------------------------------------------------------------------
// 12d. Fix round 9: a replayed success must be explicitly annotated so the
// model cannot present the re-skipped action as freshly executed. The
// `replayed` flag is transient (never persisted); the annotation is applied by
// the casaos_*_app tool handler via annotateCasaOSReplay().
// ---------------------------------------------------------------------------

test("replayed casaos success is flagged and annotated as not re-executed", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12d";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service: actions } = casaOSActions(db, workspace);
  const auth = await createAuth(db, config);
  const files = new Files(db, config, auth);
  const browser = new BrowserService(db, config, auth, files);
  const agent = new AgentService(db, config, workspace, files, actions, browser);

  const taskId = "t12d:task:1";
  await db.put(owner, "tasks", { id: taskId, status: "waiting_approval" });
  const task = { id: taskId } as unknown as AgentTask;
  const ctx = {
    guard: async () => {},
    checkpoint: async (patch: unknown) => patch,
    event: async () => {},
  } as unknown as TaskContext;
  const key = createHash("sha256")
    .update(JSON.stringify({ kind: "casaos.action", app: "plex", action: "restart", taskId }))
    .digest("hex");

  const first = await agent.prepareCasaOSAction(
    owner,
    task,
    { app: "plex", action: "restart" },
    key,
    ctx,
  );
  assert.equal(first.status, "awaiting_review");
  assert.equal(first.replayed, undefined);

  const decided = await actions.decide(owner, first.id, first.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.equal(state.puts.length, 1);

  // The resumed task re-proposes the identical action: replay, not re-execute.
  const second = await agent.prepareCasaOSAction(
    owner,
    task,
    { app: "plex", action: "restart" },
    key,
    ctx,
  );
  assert.equal(second.id, first.id);
  assert.equal(second.status, "succeeded");
  assert.equal(second.replayed, true, "replay must be flagged");
  assert.equal(state.puts.length, 1, "no second PUT");

  // The tool-handler annotation makes the re-skip explicit to the model.
  const annotated = annotateCasaOSReplay(second.result, second.replayed === true);
  assert.ok(annotated?.includes("NOT re-executed"));

  // The flag is transient: the persisted record must not carry it.
  const persisted = await db.get<{ replayed?: boolean }>(owner, "actions", first.id);
  assert.equal(persisted?.replayed, undefined);

  // A fresh task proposing the same action gets a normal review, no flag.
  const freshTaskId = "t12d:task:2";
  await db.put(owner, "tasks", { id: freshTaskId, status: "waiting_approval" });
  const freshKey = createHash("sha256")
    .update(
      JSON.stringify({
        kind: "casaos.action",
        app: "plex",
        action: "restart",
        taskId: freshTaskId,
      }),
    )
    .digest("hex");
  const fresh = await agent.prepareCasaOSAction(
    owner,
    { id: freshTaskId } as unknown as AgentTask,
    { app: "plex", action: "restart" },
    freshKey,
    ctx,
  );
  assert.equal(fresh.status, "awaiting_review");
  assert.equal(fresh.replayed, undefined);
  assert.notEqual(fresh.id, first.id);
});

test("annotateCasaOSReplay leaves fresh results untouched", () => {
  assert.equal(annotateCasaOSReplay("done", false), "done");
  assert.equal(annotateCasaOSReplay(undefined, true), undefined);
  assert.equal(annotateCasaOSReplay(undefined, false), undefined);
  const annotated = annotateCasaOSReplay("done", true);
  assert.ok(annotated?.includes("done") && annotated?.includes("NOT re-executed"));
});

// ---------------------------------------------------------------------------
// 12e. Fix round 11 (Claude sign-off koşulu 1): nesil sayaçlı idempotency.
// Reddedilmiş bir kaydın ardından açılan inceleme onaylanıp görev devam
// ettiğinde, sonraki yeniden-öneri üçüncü bir inceleme açmamalı — onaylanan
// kaydı tekrar oynatmalı. Ayrıca nesil 0'ın kimliği tarihsel sha256(key)
// olarak kalmalı.
// ---------------------------------------------------------------------------

test("denied then re-proposed then approved: later re-proposal replays instead of opening a third review", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12e";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service: actions } = casaOSActions(db, workspace);

  const data = { kind: "casaos.action", data: { app: "plex", action: "stop" } } as const;
  const taskId = "t12e:task:1";
  const key = "t12e:task:1";
  await db.put(owner, "tasks", { id: taskId, status: "waiting_approval" });

  // 1. First proposal: generation 0 keeps the historical sha256(key) ID.
  const first = await actions.propose(owner, data, key, taskId);
  assert.equal(first.status, "awaiting_review");
  assert.equal(first.id, createHash("sha256").update(key).digest("hex"));
  await actions.decide(owner, first.id, first.hash, "deny");

  // 2. Re-propose after denial: terminal denied record → fresh review at
  //    generation 1 (deterministic, not random).
  const second = await actions.propose(owner, data, key, taskId);
  assert.equal(second.status, "awaiting_review");
  assert.notEqual(second.id, first.id);
  assert.equal(
    second.id,
    createHash("sha256").update(`${key}#1`).digest("hex"),
    "second review must live at generation 1",
  );

  // 3. Approve the second review: exactly one PUT.
  const decided = await actions.decide(owner, second.id, second.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.equal(state.puts.length, 1);

  // 4. The resumed task re-proposes: must replay generation 1, never open
  //    a third review.
  const third = await actions.propose(owner, data, key, taskId);
  assert.equal(third.id, second.id, "re-proposal must replay the approved review");
  assert.equal(third.status, "succeeded");
  assert.equal(third.replayed, true);
  assert.equal(state.puts.length, 1, "no second PUT");

  const awaiting = (await db.scan<{ status: string }>("actions")).filter(
    (r) => r.owner === owner && r.value.status === "awaiting_review",
  );
  assert.equal(awaiting.length, 0, "no stray awaiting_review record");
});

// ---------------------------------------------------------------------------
// 12f. Fix round 11 (Claude sign-off koşulu 1, senaryo C): süresi dolmuş bir
// incelemenin ardından aynı çağrı iki kez tekrarlanırsa tek bekleyen inceleme
// kalmalı — ikinci kopya açılmamalı.
// ---------------------------------------------------------------------------

test("expired review re-proposed twice yields a single pending review", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12f";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  const { service: actions } = casaOSActions(db, workspace);

  const data = { kind: "casaos.action", data: { app: "plex", action: "restart" } } as const;
  const taskId = "t12f:task:1";
  const key = "t12f:task:1";
  await db.put(owner, "tasks", { id: taskId, status: "waiting_approval" });

  const first = await actions.propose(owner, data, key, taskId);
  assert.equal(first.status, "awaiting_review");
  // Simulate expiry (decide() marks it lazily at decision time).
  await db.put(owner, "actions", { ...first, status: "expired" });

  // Task retry re-proposes: fresh review at generation 1.
  const second = await actions.propose(owner, data, key, taskId);
  assert.equal(second.status, "awaiting_review");
  assert.notEqual(second.id, first.id);

  // The same retry runs again: must return the pending generation-1 review,
  // not open a second copy.
  const third = await actions.propose(owner, data, key, taskId);
  assert.equal(third.id, second.id, "must return the pending review, not duplicate it");
  assert.equal(third.status, "awaiting_review");

  const awaiting = (await db.scan<{ status: string }>("actions")).filter(
    (r) => r.owner === owner && r.value.status === "awaiting_review",
  );
  assert.equal(awaiting.length, 1, "exactly one pending review");
});

// ---------------------------------------------------------------------------
// 12c. Fix round 8: kind-aware action routing must survive a disconnected
// Google account. The app wires ActionService.connected/connection by kind
// (app.ts): "casaos.action" consults the CasaOS credential store, every other
// kind consults Google. This test pins that behavior.
// ---------------------------------------------------------------------------

test("action routing is kind-aware: casaos approvable while Google is disconnected", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t12e";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const workspace = testWorkspace(db, config);
  // The harness stubs connected=false for every non-casaos kind, i.e. the
  // Google account is disconnected while CasaOS credentials are saved.
  const { service } = casaOSActions(db, workspace);

  const taskId = "t12e:task:1";
  await db.put(owner, "tasks", { id: taskId, status: "waiting_approval" });

  // A Google-kind review cannot even be prepared without a connection...
  await assert.rejects(
    () =>
      service.propose(
        owner,
        { kind: "email.send", data: { to: ["a@example.com"], subject: "x", body: "y" } },
        "t12e:k",
        taskId,
      ),
    /Connect Google before preparing an action/,
  );

  // ...but a CasaOS action proposes and approves fine on its own credentials.
  const proposal = await service.propose(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "restart" } },
    "t12e:k2",
    taskId,
  );
  assert.equal(proposal.status, "awaiting_review");
  const decided = await service.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.equal(state.puts.length, 1);
});

// ---------------------------------------------------------------------------
// 13. Fix round: redaction covers env-var, JSON and header forms.
// ---------------------------------------------------------------------------

test("log redaction covers env, JSON and header secret forms", () => {
  const dirty = [
    "POSTGRES_PASSWORD=hunter2",
    "MYSQL_ROOT_PASSWORD=hunter2",
    "JWT_SECRET=abc123def",
    "ACCESS_TOKEN=abc123def",
    "X-Api-Key: abc123def",
    '{"db_password":"s3krit-x"}',
    'password="my pass phrase"',
    "tokenizer loaded",
  ].join("\n");
  const clean = redactCasaOSLogs(dirty);
  for (const secret of ["hunter2", "abc123def", "s3krit-x", "my pass phrase"])
    assert.ok(!clean.includes(secret), `leaked: ${secret}`);
  assert.ok(clean.includes("tokenizer loaded"), "benign line was mangled");
  assert.ok(clean.includes("[redacted]"));
});

// ---------------------------------------------------------------------------
// 14. Fix round: PUT transport classification (cause.code).
// ---------------------------------------------------------------------------

test("PUT transport: only ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ENETUNREACH are definite failures", async () => {
  const loginOk = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    throw new Error(`unexpected ${u.pathname}`);
  };
  const failingPut = (code: string) => async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login") return loginOk(url);
    if (u.pathname.endsWith("/status") && init.method === "PUT")
      throw Object.assign(new Error("transport"), { cause: { code } });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };

  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]) {
    fetchHandler = failingPut(code);
    const err = await testClient(`t14-${code}`)
      .setAppStatus("plex", "stop")
      .catch((e) => e);
    assert.ok(!(err instanceof OutcomeUnknownError), `${code} should be a definite failure`);
    assert.equal(err.status, 502);
  }
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
    fetchHandler = failingPut(code);
    const err = await testClient(`t14-${code}`)
      .setAppStatus("plex", "stop")
      .catch((e) => e);
    assert.ok(err instanceof OutcomeUnknownError, `${code} should be outcome_unknown`);
  }
  // No cause at all (e.g. plain abort): ambiguous as well.
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login") return loginOk(url);
    if (u.pathname.endsWith("/status") && init.method === "PUT")
      throw new DOMException("The operation timed out", "TimeoutError");
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const timeoutErr = await testClient("t14-timeout")
    .setAppStatus("plex", "stop")
    .catch((e) => e);
  assert.ok(timeoutErr instanceof OutcomeUnknownError);
});

// ---------------------------------------------------------------------------
// 15. Fix round: runtime action validation; poll failure never fails the action.
// ---------------------------------------------------------------------------

test("setAppStatus rejects invalid actions at runtime", async () => {
  const client = testClient("t15");
  const err = await (
    client.setAppStatus as unknown as (app: string, action: string) => Promise<void>
  )("plex", "explode").catch((e) => e);
  assert.equal(err.status, 400);
  assert.match(err.message, /Invalid CasaOS action/);
});

test("post-PUT poll failure reports the request instead of throwing", async () => {
  let appgridCalls = 0;
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/compose/plex/status" && init.method === "PUT")
      return json(200, { message: "compose app status is being changed asynchronously" });
    if (u.pathname === "/v2/app_management/web/appgrid") {
      appgridCalls += 1;
      if (appgridCalls === 1) return json(200, { data: appgridFixture }); // validateApp
      throw new Error("appgrid exploded"); // every poll fails
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const owner = "t15b";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const creds = await loadCasaOSCredentials(db, config, owner);
  const workspace = testWorkspace(db, config);
  const result = await workspace.execute(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "stop" } },
    creds?.connectionId,
  );
  assert.match(result, /Stop of "plex" was requested on CasaOS/);
  assert.match(result, /could not be read/);
});

// ---------------------------------------------------------------------------
// 16. Fix round: log tail keeps the LAST 1MB; ?lines= is requested; oversized
//     bodies are rejected without unbounded reads.
// ---------------------------------------------------------------------------

test("appLogs requests ?lines= and keeps the tail, not the head", async () => {
  const state = mockState();
  let requestedUrl = "";
  state.logsData = Array.from({ length: 200 }, (_, i) => `log line ${i}`).join("\n");
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    const logsMatch = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)\/logs$/);
    if (logsMatch) {
      requestedUrl = url;
      return json(200, { data: state.logsData ?? "" });
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const client = testClient("t16");
  const result = await client.appLogs("plex", 5);
  assert.ok(requestedUrl.includes("lines=5"), `expected ?lines= in ${requestedUrl}`);
  assert.equal(result.lines.length, 5);
  assert.ok(result.lines[4].includes("log line 199"));
});

test("appLogs keeps the last 1MB of a huge log, not the first", async () => {
  // ~1.5MB of log lines; the mock bypasses ?lines= (endpoint ignores it).
  const lines = Array.from(
    { length: 30000 },
    (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(40)}`,
  );
  const big = lines.join("\n");
  assert.ok(Buffer.byteLength(big, "utf8") > 1_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify({ data: big }), "utf8") < 2_000_000);
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    if (u.pathname.endsWith("/logs")) return json(200, { data: big });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const client = testClient("t16b");
  const result = await client.appLogs("plex");
  const text = result.lines.join("\n");
  assert.ok(!text.includes("line 00000"), "head of the log leaked through");
  assert.ok(text.includes("line 29999"), "tail of the log was dropped");
  assert.equal(result.truncated, true);
});

test("appLogs rejects oversized bodies without unbounded reads", async () => {
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    if (u.pathname.endsWith("/logs"))
      return new Response(JSON.stringify({ data: "x".repeat(100) }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": "999999999" },
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const client = testClient("t16c");
  const err = await client.appLogs("plex").catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /oversized/);
});

// ---------------------------------------------------------------------------
// 17. Fix round: validation errors never echo raw input.
// ---------------------------------------------------------------------------

test("validateApp errors never echo the raw input", async () => {
  fetchHandler = casaOSMock({ ...mockState() });
  const client = testClient("t17");
  const evil = '../../etc/passwd"><script>';
  const err1 = await client.validateApp(evil).catch((e) => e);
  assert.equal(err1.status, 404);
  assert.ok(!err1.message.includes(evil), "raw input echoed in error");
  const err2 = await client.getApp("no-such-app").catch((e) => e);
  assert.equal(err2.status, 404);
  assert.ok(!err2.message.includes("no-such-app"));
});

// ---------------------------------------------------------------------------
// 18. Fix round: CasaOS upstream 401/403/404 never surface as our 401/403/404.
// ---------------------------------------------------------------------------

test("casaos upstream statuses map to 409/502, never our 401/403/404", async () => {
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(403, { message: "forbidden" });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const err = await testClient("t18")
    .listApps()
    .catch((e) => e);
  assert.equal(err.status, 502);
  assert.notEqual(err.status, 403);
});

// ---------------------------------------------------------------------------
// 19. Fix round 2: secret query-string / fragment params are redacted.
// ---------------------------------------------------------------------------

test("log redaction covers secret query-string and fragment params", () => {
  const dirty = [
    "GET https://example.com/api?token=SUPERSECRET",
    "https://example.com/?x=1&api_key=SECRET123",
    "callback https://example.com/#access_token=zzz",
    "https://example.com/?page=2&sort=name",
  ].join("\n");
  const clean = redactCasaOSLogs(dirty);
  for (const secret of ["SUPERSECRET", "SECRET123", "zzz"])
    assert.ok(!clean.includes(secret), `leaked: ${secret}`);
  assert.ok(clean.includes("?page=2&sort=name"), "benign query string was mangled");
});

// ---------------------------------------------------------------------------
// 20. Fix round 2: userinfo redaction tolerates @ and / in the password.
// ---------------------------------------------------------------------------

test("log redaction scrubs userinfo with special chars in password", () => {
  const dirty = [
    "dial https://admin:abc@123@192.168.4.27/ done",
    "dial https://u:p@ss/w@host/ done",
    "open https://host/path in browser",
  ].join("\n");
  const clean = redactCasaOSLogs(dirty);
  for (const secret of ["abc@123", "p@ss/w"])
    assert.ok(!clean.includes(secret), `leaked: ${secret}`);
  assert.ok(clean.includes("https://host/path"), "plain URL was mangled");
  assert.ok(clean.includes("[redacted-userinfo]@192.168.4.27/"));
  // Authority-scoped: the raw "/" ends the authority, so only "u:p" is
  // userinfo; the "/w@host/" path remainder stays (no credential leak).
  assert.ok(clean.includes("[redacted-userinfo]@ss/w@host/"));
});

// ---------------------------------------------------------------------------
// 21. Fix round 2: body-less responses are never read without Content-Length.
// ---------------------------------------------------------------------------

test("no-body responses are rejected unread without a valid Content-Length", async () => {
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    if (u.pathname.endsWith("/logs")) {
      const fake = {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: null,
        text: async (): Promise<string> => {
          throw new Error("unbounded read attempted");
        },
      } as unknown as Response;
      return fake;
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const err = await testClient("t19")
    .appLogs("plex")
    .catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /oversized/);
});

// ---------------------------------------------------------------------------
// 22. Fix round 2: claim() treats malformed expiresAt as non-matching.
// ---------------------------------------------------------------------------

test("db.claim returns null on malformed expiresAt instead of throwing", async () => {
  const owner = "claim-corrupt";
  await db.put(owner, "actions", {
    id: "corrupt-1",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: "garbage",
    kind: "casaos.action",
    data: {},
  });
  const claimed = await db.claim(
    owner,
    "corrupt-1",
    "executing",
    new Date().toISOString(),
    "review-hash",
  );
  assert.equal(claimed, null);
  // Positive control: a well-formed record still claims.
  await db.put(owner, "actions", {
    id: "valid-1",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "casaos.action",
    data: {},
  });
  const ok = await db.claim(owner, "valid-1", "executing", new Date().toISOString(), "review-hash");
  assert.ok(ok, "valid record should claim");
});

// ---------------------------------------------------------------------------
// 23. Fix round 3: systemUtilization tolerates net as array or object.
// ---------------------------------------------------------------------------

test("systemUtilization sums net array entries", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v1/sys/utilization")
      return json(200, {
        data: {
          cpu: { percent: 10 },
          mem: { usedPercent: 50 },
          net: [
            { up: 100, down: 200 },
            { up: 50, down: 75 },
          ],
        },
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const status = await testClient("net-array").systemUtilization();
  assert.equal(status.network_up_bytes, 150);
  assert.equal(status.network_down_bytes, 275);
});

test("systemUtilization still reads object-shaped net", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const status = await testClient("net-object").systemUtilization();
  assert.equal(status.network_up_bytes, 1000);
  assert.equal(status.network_down_bytes, 2000);
});

// ---------------------------------------------------------------------------
// 24. Fix round 3: GET timeout becomes a clean 502.
// ---------------------------------------------------------------------------

test("GET timeout becomes a clean 502, not a raw DOMException", async () => {
  fetchHandler = async (url: string, _init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const err = await testClient("t-get-timeout")
    .listApps()
    .catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /took too long/);
});

// ---------------------------------------------------------------------------
// 25. Fix round 3: userinfo redaction leaves path-@ URLs alone.
// ---------------------------------------------------------------------------

test("userinfo redaction leaves path-@ URLs alone but scrubs credentials", () => {
  assert.equal(
    redactCasaOSLogs("npm i https://registry.npmjs.org/@types/node"),
    "npm i https://registry.npmjs.org/@types/node",
  );
  assert.equal(
    redactCasaOSLogs("see https://mastodon.social/@alice/ for more"),
    "see https://mastodon.social/@alice/ for more",
  );
  assert.equal(
    redactCasaOSLogs("db at https://user:p@ss@host/ connected"),
    "db at https://[redacted-userinfo]@host/ connected",
  );
  assert.equal(
    redactCasaOSLogs("login https://admin:abc@123@192.168.4.27/ now"),
    "login https://[redacted-userinfo]@192.168.4.27/ now",
  );
});

// ---------------------------------------------------------------------------
// 26. Fix round 3: Cookie headers and provider token formats are redacted.
// ---------------------------------------------------------------------------

test("redaction scrubs Cookie headers and provider token formats", () => {
  const out = redactCasaOSLogs(
    [
      "Cookie: session=abc123; theme=dark",
      "Set-Cookie: id=xyz789; Path=/",
      "Using token ghp_abcdefghijklmnopqrst for deploy",
      "slack xoxb-123456789012-abcdefghi here",
      "aws key AKIAIOSFODNN7EXAMPLE leaked",
      "shipping costs are final",
    ].join("\n"),
  );
  assert.match(out, /Cookie: \[redacted\]/);
  assert.match(out, /Set-Cookie: \[redacted\]/);
  assert.ok(!out.includes("ghp_abcdefghijklmnopqrst"), "github token scrubbed");
  assert.ok(!out.includes("xoxb-123456789012-abcdefghi"), "slack token scrubbed");
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"), "aws key scrubbed");
  assert.ok(out.includes("shipping costs are final"), "benign line untouched");
});

// ---------------------------------------------------------------------------
// 27. Fix round 3: malformed login JSON is a 502, never a 400.
// ---------------------------------------------------------------------------

test("accessToken maps malformed login JSON to 502", async () => {
  fetchHandler = async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return new Response("this is not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    throw new Error("unexpected");
  };
  const err = await testClient("t-bad-login-json")
    .listApps()
    .catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /unreadable/);
});

// ---------------------------------------------------------------------------
// 28. Fix round 3: PUT body is byte-for-byte the quoted action string.
// ---------------------------------------------------------------------------

test('PUT body is byte-for-byte "start" with application/json', async () => {
  let contentType: string | null = null;
  let body: string | null = null;
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    if (u.pathname.endsWith("/status") && init.method === "PUT") {
      contentType = headers["Content-Type"] ?? null;
      body = String(init.body);
      return json(200, { message: "ok" });
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  await testClient("t-put-body").setAppStatus("plex", "start");
  // body/contentType are assigned inside the fetch stub; read them through
  // `unknown` so TS closure narrowing (which sees only the `null` init) can't
  // poison the assertions below.
  const snapshot = { body, contentType } as { body: unknown; contentType: unknown };
  assert.equal(snapshot.body, '"start"');
  assert.strictEqual(String(snapshot.body).length, 7);
  assert.equal(snapshot.contentType, "application/json");
});

// ---------------------------------------------------------------------------
// 29. Fix round 3: getApp fetches the appgrid only once (short cache).
// ---------------------------------------------------------------------------

test("getApp fetches the appgrid only once", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const detail = await testClient("t-appgrid-cache").getApp("plex");
  assert.equal(detail.name, "plex");
  const appgridHits = state.gets.filter((p) => p === "/v2/app_management/web/appgrid").length;
  assert.equal(appgridHits, 1);
});

// ---------------------------------------------------------------------------
// 30. Fix round 3: out-of-range expiresAt never throws in claim().
// ---------------------------------------------------------------------------

test("db.claim treats out-of-range timestamps as non-matching", async () => {
  const owner = "claim-range";
  await db.put(owner, "actions", {
    id: "bad-month",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: "2026-13-45T00:00:00Z",
    kind: "casaos.action",
    data: {},
  });
  const claimed = await db.claim(
    owner,
    "bad-month",
    "executing",
    new Date().toISOString(),
    "review-hash",
  );
  assert.equal(claimed, null);
});

/* ============ 31. safe_timestamptz: malformed expiresAt never throws ============ */

test("db.claim never throws on out-of-range or garbage expiresAt", async () => {
  const owner = "claim-malformed-strict";
  // Values that pass a loose prefix regex but are not real timestamps:
  // the claim must skip them (null), never throw from the DB cast.
  const malformed = [
    ["exp-bad-month-day", "2026-99-99T12:00:00Z"],
    ["exp-garbage", "2026-01-01Tgarbage"],
    ["exp-bad-day", "2026-02-31T00:00:00Z"],
  ] as const;
  for (const [id, expiresAt] of malformed) {
    await db.put(owner, "actions", {
      id,
      status: "awaiting_review",
      hash: "review-hash",
      kind: "casaos.action",
      expiresAt,
      data: { app: "plex" },
    });
    const claimed = await db.claim(owner, id, "executing", new Date().toISOString(), "review-hash");
    assert.equal(claimed, null, `malformed expiresAt must be skipped: ${expiresAt}`);
  }
});
/* ============================================================================
 * Merge regressions: the CasaOS layer against marathon-audit's hardened db.ts.
 *
 * These fail without the merge. Before it, claim() filtered expiresAt with a
 * shape regex and then cast ::timestamptz directly; the two tests above are
 * what caught that. The ones below pin the interaction itself: a malformed
 * expiry on one CasaOS review must not stop an unrelated, well-formed review
 * from being claimed in the same statement, and a CasaOS action must still be
 * un-amendable and owner-scoped exactly as the marathon-audit fixes require.
 * ========================================================================== */

test("a malformed expiry does not block a well-formed claim in the same statement", async () => {
  const owner = "claim-coexist";
  // Two rows that differ only in expiresAt. Without safe_timestamptz the
  // out-of-range row raises 22008 and the healthy review beside it is never
  // claimed -- one poisoned record silently stalls every other action.
  await db.put(owner, "actions", {
    id: "poison",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: "2026-13-45T00:00:00Z",
    kind: "casaos.action",
    data: { app: "plex" },
  });
  await db.put(owner, "actions", {
    id: "healthy",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    kind: "casaos.action",
    data: { app: "plex" },
  });
  assert.equal(
    await db.claim(owner, "poison", "executing", new Date().toISOString(), "review-hash"),
    null,
    "the malformed row is skipped, not claimed",
  );
  const claimed = await db.claim<{ status: string }>(
    owner,
    "healthy",
    "executing",
    new Date().toISOString(),
    "review-hash",
  );
  assert.equal(claimed?.status, "executing", "the healthy review still claims cleanly");
});

test("a CasaOS action claims only for its own owner", async () => {
  const owner = "claim-owner-a";
  const other = "claim-owner-b";
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await db.put(owner, "actions", {
    id: "shared-id",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt,
    kind: "casaos.action",
    data: { app: "plex" },
  });
  assert.equal(
    await db.claim(other, "shared-id", "executing", new Date().toISOString(), "review-hash"),
    null,
    "another owner cannot claim a CasaOS action by guessing its id",
  );
  const claimed = await db.claim<{ status: string }>(
    owner,
    "shared-id",
    "executing",
    new Date().toISOString(),
    "review-hash",
  );
  assert.equal(claimed?.status, "executing");
});

test("an expired CasaOS review is not claimable, and the claim is a no-op", async () => {
  const owner = "claim-expired";
  await db.put(owner, "actions", {
    id: "stale",
    status: "awaiting_review",
    hash: "review-hash",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    kind: "casaos.action",
    data: { app: "plex" },
  });
  assert.equal(
    await db.claim(owner, "stale", "executing", new Date().toISOString(), "review-hash"),
    null,
  );
  const still = await db.get<{ status: string }>(owner, "actions", "stale");
  assert.equal(still?.status, "awaiting_review", "the row is left untouched, not mutated");
});

/* ============ 32. URL userinfo redaction: punctuation + query-@ ============ */

test("userinfo redaction survives trailing punctuation and query-@ confusion", () => {
  assert.equal(
    redactCasaOSLogs("Failed to connect to https://alice:secret@example.com, retrying..."),
    "Failed to connect to https://[redacted-userinfo]@example.com, retrying...",
  );
  assert.equal(
    redactCasaOSLogs("(see https://bob:pw@example.com)"),
    "(see https://[redacted-userinfo]@example.com)",
  );
  assert.equal(
    redactCasaOSLogs("at https://carol:pw@example.com."),
    "at https://[redacted-userinfo]@example.com.",
  );
  assert.equal(
    redactCasaOSLogs("[https://dave:pw@example.com]"),
    "[https://[redacted-userinfo]@example.com]",
  );
  // @ inside the query string must not confuse the userinfo match; query stays intact.
  assert.equal(
    redactCasaOSLogs("GET https://user:pass@example.com/path?q=foo@bar done"),
    "GET https://[redacted-userinfo]@example.com/path?q=foo@bar done",
  );
  // Path @ without userinfo stays untouched.
  assert.equal(
    redactCasaOSLogs("npm i https://registry.npmjs.org/@types/node"),
    "npm i https://registry.npmjs.org/@types/node",
  );
});

/* ============ 33. truncateToTail UTF-8 safety ============ */

test("truncateToTail never splits a multi-byte char", () => {
  const text = `${"a".repeat(10)}😀${"b".repeat(10)}`; // 10 + 4 + 10 = 24 bytes
  // maxBytes 13 -> raw cut at byte 11, inside the 4-byte emoji (bytes 10-13).
  const { text: tail, truncated } = truncateToTail(text, 13);
  assert.equal(truncated, true);
  assert.ok(!tail.includes("�"), "no replacement character");
  assert.equal(tail, "b".repeat(10));
});

/* ============ 34. BLOCKER: appLogs redacts BEFORE truncating ============ */

test("appLogs redacts before the 1MB cut: a long secret value cannot survive", async () => {
  // Attack shape from the review: `password=` followed by 1,000,100 secret
  // bytes. Truncating first would drop the `password=` key and leave bare
  // secret chars the redactor can no longer recognize.
  const big = `password=${"S".repeat(1_000_100)}`;
  assert.ok(Buffer.byteLength(big, "utf8") > 1_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify({ data: big }), "utf8") < 2_000_000);
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: "t", refresh_token: "r" } },
      });
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    if (u.pathname.endsWith("/logs")) return json(200, { data: big });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const client = testClient("t34");
  const result = await client.appLogs("plex");
  const text = result.lines.join("\n");
  assert.ok(!/S{10}/.test(text), "secret material survived redaction");
  assert.ok(text.includes("[redacted]"), "expected the redaction marker");
  assert.equal(result.truncated, true);
});

/* ============ 35. IPv6 userinfo is redacted ============ */

test("redactUrlUserinfo handles bracketed IPv6 hosts", () => {
  assert.equal(
    redactCasaOSLogs("fetch http://alice:secret@[::1]/foo now"),
    "fetch http://[redacted-userinfo]@[::1]/foo now",
  );
  assert.equal(
    redactCasaOSLogs("at https://bob:pw@[2001:db8::1]:8080/x."),
    "at https://[redacted-userinfo]@[2001:db8::1]:8080/x.",
  );
});

/* ============ 36. Indented Cookie headers are redacted ============ */

test("redactCasaOSLogs scrubs indented Cookie headers", () => {
  const out = redactCasaOSLogs("  Cookie: session=SECRET-VALUE\n\tSet-Cookie: id=OTHER-SECRET");
  assert.ok(!out.includes("SECRET-VALUE"), `leaked: ${out}`);
  assert.ok(!out.includes("OTHER-SECRET"), `leaked: ${out}`);
  assert.ok(out.includes("Cookie: [redacted]"));
});

/* ============ 37. Oversized login bodies are rejected, not materialized ============ */

test("verifyCasaOSLogin rejects an oversized response body with 502", async () => {
  fetchHandler = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login" && init.method === "POST")
      return new Response("x".repeat(200_000), { status: 200 });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const err = await verifyCasaOSLogin("http://127.0.0.1", "u", "p").catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /oversized/);
});

/* ============ 38. HTTP transport policy ============ */

test("CasaOSClient rejects non-loopback plain HTTP without the opt-out", () => {
  const opts = (baseUrl: string, allowInsecureHttp?: boolean) => ({
    baseUrl,
    owner: "t38",
    loadCredentials: async () => null,
    ...(allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
  });
  const err = (() => {
    try {
      new CasaOSClient(opts("http://192.168.4.27"));
      return null;
    } catch (e) {
      return e as { status?: number; message?: string };
    }
  })();
  assert.ok(err, "expected a configuration error");
  assert.equal(err.status, 503);
  assert.match(String(err.message), /plain HTTP/);
  assert.match(String(err.message), /CASAOS_ALLOW_INSECURE_HTTP/);

  // Explicit opt-out allows it.
  new CasaOSClient(opts("http://192.168.4.27", true));
  // Loopback HTTP and any HTTPS are always fine.
  new CasaOSClient(opts("http://127.0.0.1"));
  new CasaOSClient(opts("http://localhost:8080"));
  // Bracketed IPv6 loopback: WHATWG URL keeps the brackets on .hostname.
  new CasaOSClient(opts("http://[::1]"));
  new CasaOSClient(opts("https://192.168.4.27"));
});

test("verifyCasaOSLogin enforces the transport policy before any fetch", async () => {
  let fetched = false;
  fetchHandler = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  const err = await verifyCasaOSLogin("http://192.168.4.27", "u", "p").catch((e) => e);
  assert.equal(err.status, 503);
  assert.match(err.message, /plain HTTP/);
  assert.equal(fetched, false);
});

test("CasaOSClient rejects non-http(s) schemes", () => {
  for (const baseUrl of ["ftp://192.168.4.27", "file:///etc/passwd", "ws://192.168.4.27"]) {
    const err = (() => {
      try {
        new CasaOSClient({ baseUrl, owner: "t-scheme", loadCredentials: async () => null });
        return null;
      } catch (e) {
        return e as { status?: number; message?: string };
      }
    })();
    assert.ok(err, `expected a configuration error for ${baseUrl}`);
    assert.equal(err.status, 503);
    assert.match(String(err.message), /http: or https:/);
  }
});

/* ============ 39. Redirects are never followed with credentials ============ */

test("login never follows redirects with credentials (307 and 308)", async () => {
  // This test uses REAL loopback HTTP servers and the REAL fetch, because the
  // mocked fetch cannot prove redirect behavior. The suite-wide mock is
  // restored afterwards.
  const mockedFetch = globalThis.fetch;
  globalThis.fetch = realFetch;
  let redirectStatus = 307;
  let evilHits = 0;
  const evil = createServer((_req, res) => {
    evilHits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const login = createServer((req, res) => {
    // Consume the request body, then redirect to the "evil" host.
    req.resume();
    req.on("end", () => {
      const evilPort = (evil.address() as { port: number }).port;
      res.writeHead(redirectStatus, { Location: `http://127.0.0.1:${evilPort}/stolen` });
      res.end();
    });
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => login.listen(0, "127.0.0.1", r));
  try {
    const loginPort = (login.address() as { port: number }).port;
    for (const status of [307, 308]) {
      redirectStatus = status;
      evilHits = 0;
      const err = await verifyCasaOSLogin(
        `http://127.0.0.1:${loginPort}`,
        "alice",
        "s3cret-fake",
      ).catch((e) => e);
      assert.ok(err instanceof Error, `expected login to throw on HTTP ${status}`);
      assert.equal(
        evilHits,
        0,
        `evil server must receive zero requests (HTTP ${status}); credentials must not be re-POSTed`,
      );
    }
  } finally {
    globalThis.fetch = mockedFetch;
    await new Promise<void>((r) => login.close(() => r()));
    await new Promise<void>((r) => evil.close(() => r()));
  }
});

/* ============ 38. Escaped quotes inside quoted secret values ============ */

test("log redaction handles escaped quotes inside quoted secret values", () => {
  const out = redactCasaOSLogs('{"password":"abc\\"TOPSECRET"}');
  assert.ok(!out.includes("TOPSECRET"), `leaked: ${out}`);
  assert.ok(out.includes("[redacted]"), `expected redaction marker: ${out}`);
  const out2 = redactCasaOSLogs("{'api_key':'abc\\'TOPSECRET2'}");
  assert.ok(!out2.includes("TOPSECRET2"), `leaked: ${out2}`);
  assert.ok(out2.includes("[redacted]"), `expected redaction marker: ${out2}`);
});

/* ============ 39. Unicode/IDN host userinfo is redacted ============ */

test("redactUrlUserinfo handles Unicode/IDN hosts", () => {
  assert.equal(
    redactCasaOSLogs("see https://alice:secret@例え.テスト/path now"),
    "see https://[redacted-userinfo]@例え.テスト/path now",
  );
});

/* ============ 40. TOCTOU: credential swap between review check and PUT ============ */

test("credential saved between review check and PUT cannot hijack the mutation", async () => {
  const testOwner = "t7toctou";
  clearCasaOSTokenCache(testOwner);
  const puts: Array<string | null> = [];
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname === "/v1/users/login" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { username?: string };
      return json(200, {
        success: 200,
        message: "ok",
        data: { token: { access_token: `token-for-${body.username ?? "unknown"}` } },
      });
    }
    if (u.pathname === "/v2/app_management/web/appgrid") return json(200, { data: appgridFixture });
    const m = u.pathname.match(/^\/v2\/app_management\/compose\/(.+)\/status$/);
    if (m && init.method === "PUT") {
      puts.push(headers.Authorization ?? null);
      return json(200, { success: 200, message: "ok", data: {} });
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };

  // Credential A saved normally (live login through the mock).
  const { connectionId } = await saveCasaOSCredentials(db, config, testOwner, "alice", "secret-A");

  // Simulate credential B being saved AFTER the review-time connectionId check
  // but BEFORE the mutation's internal credential reload: the first db read
  // returns A (outer check passes), every later read returns B.
  const realGet = db.get.bind(db);
  let credentialReads = 0;
  db.get = (async <T>(o: string, kind: string, id: string): Promise<T | null> => {
    if (o === testOwner && kind === "credentials" && id === "casaos") {
      credentialReads += 1;
      if (credentialReads > 1) {
        return {
          id: "casaos",
          connectionId: "conn-B",
          secret: encryptSecret(
            JSON.stringify({ username: "bob", password: "secret-B" }),
            ENCRYPTION_KEY,
          ),
        } as unknown as T;
      }
    }
    return realGet<T>(o, kind, id);
  }) as Store["get"];
  try {
    const workspace = testWorkspace(db, config);
    await workspace.execute(
      testOwner,
      { kind: "casaos.action", data: { app: "plex", action: "stop" } },
      connectionId,
    );
  } finally {
    db.get = realGet;
  }
  assert.equal(puts.length, 1, "exactly one PUT must go out");
  assert.equal(
    puts[0],
    "token-for-alice",
    "PUT must use the review-bound credential A, never the swapped-in credential B",
  );
});

// ---------------------------------------------------------------------------
// 17. Fix round 8 regressions: ReDoS-safe redaction, URL userinfo policy,
//     lazy CasaOS client construction.
// ---------------------------------------------------------------------------

test("redaction completes in bounded time on 1MB pathological inputs", () => {
  const samples: Array<[string, string]> = [
    ["whitespace/newline runs", " ".repeat(500_000) + "\n".repeat(500_000)],
    ["url prefix + dot runs", `https://h/${".".repeat(999_990)}`],
    ["dotted labels", "a.".repeat(500_000)],
    ["token-ish run", "tokentoken".repeat(100_000)],
    ["query param run", "?tokentoken".repeat(100_000)],
  ];
  for (const [name, input] of samples) {
    assert.ok(input.length >= 1_000_000, `${name}: sample too small`);
    const start = Date.now();
    redactCasaOSLogs(input);
    const ms = Date.now() - start;
    assert.ok(ms < 2000, `${name}: redaction took ${ms}ms (ReDoS regression)`);
  }
});

test("capLogLines bounds every line before redaction", () => {
  const long = "x".repeat(5000);
  const capped = capLogLines(`short\n${long}\n${long}`);
  const lines = capped.split("\n");
  assert.equal(lines[0], "short");
  for (const line of lines.slice(1)) {
    assert.ok(line.length <= MAX_LINE_CHARS + 30, `line not capped: ${line.length}`);
    assert.ok(line.endsWith("…[line truncated]"));
  }
  assert.equal(capLogLines(""), "");
});

function casaOSUrlError(baseUrl: string): AppError {
  try {
    assertCasaOSUrlAllowed(baseUrl, false);
  } catch (e) {
    return e as AppError;
  }
  throw new Error(`expected a policy error for ${baseUrl}`);
}

test("CASAOS_API_URL policy errors never echo the URL or embedded secrets", () => {
  const invalid = casaOSUrlError("http://[::1");
  assert.equal(invalid.status, 503);
  assert.match(invalid.message, /not a valid URL/);
  assert.ok(!invalid.message.includes("http://[::1"), "URL must not be echoed");

  const withCreds = casaOSUrlError("https://alice:SUPERSECRET@example.com");
  assert.equal(withCreds.status, 503);
  assert.match(withCreds.message, /embedded credentials/);
  assert.ok(!withCreds.message.includes("SUPERSECRET"), "password must not leak");
  assert.ok(!withCreds.message.includes("alice"), "username must not leak");
});

test("login transport failure does not echo the configured URL", async () => {
  fetchHandler = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const err = (await verifyCasaOSLogin("http://192.168.4.99", "u", "p", true).catch(
    (e) => e,
  )) as AppError;
  assert.equal(err.status, 502);
  assert.match(err.message, /did not respond to login/);
  assert.ok(!err.message.includes("192.168.4.99"), "URL must not be echoed");
});

test("buildCasaOSTools builds lazily: no client at setup, 503 per call on bad config", async () => {
  const state = mockState();
  fetchHandler = casaOSMock(state);
  const owner = "t17c";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  // Config whose CASAOS_API_URL the transport policy rejects: an eager client
  // construction at tool-build time would throw 503 for every task, even
  // unrelated ones.
  const badConfig = {
    ...config,
    casaosApiUrl: "http://192.168.4.27",
    casaosAllowInsecureHttp: false,
  };
  const workspace = testWorkspace(db, badConfig);
  let constructions = 0;
  const realCasaOS = workspace.casaOS.bind(workspace);
  workspace.casaOS = (o: string) => {
    constructions += 1;
    return realCasaOS(o);
  };

  const scope = {
    service: { workspace, config: badConfig },
    owner,
    ctx: {},
    getTask: () => ({ id: "t17c:task:1" }),
    setTask: () => {},
    setOutcome: () => {},
    tool: (name: string, description: string, parameters: unknown, execute: unknown) => ({
      name,
      description,
      parameters,
      execute,
    }),
  };
  const tools = buildCasaOSTools(scope as unknown as Parameters<typeof buildCasaOSTools>[0]);
  assert.equal(tools.length, 7);
  assert.equal(constructions, 0, "client must not be constructed at tool-build time");

  const list = tools.find((t) => t.name === "casaos_list_apps");
  assert.ok(list, "casaos_list_apps registered");
  const err = (await (list.execute as (args: unknown) => Promise<unknown>)({}).catch(
    (e) => e,
  )) as AppError;
  assert.equal(err.status, 503, "policy failure surfaces on the tool call");
  assert.equal(constructions, 1, "client constructed lazily on first tool call");
});

// ---------------------------------------------------------------------------
// 25. Live-verified 2026-10-01: net uses bytesSent/bytesRecv; appgrid entries
//     may lack a status key.
// ---------------------------------------------------------------------------

test("systemUtilization sums live bytesSent/bytesRecv across interfaces", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v1/sys/utilization")
      return json(200, {
        data: {
          cpu: { percent: 10 },
          mem: { usedPercent: 50 },
          net: [
            { name: "eno1", bytesSent: 442228041040, bytesRecv: 190719154952 },
            { name: "eth0", bytesSent: 100, bytesRecv: 200 },
          ],
        },
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const status = await testClient("net-live").systemUtilization();
  assert.equal(status.network_up_bytes, 442228041140);
  assert.equal(status.network_down_bytes, 190719155152);
});

test("systemUtilization prefers bytesSent/bytesRecv over legacy up/down keys", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v1/sys/utilization")
      return json(200, {
        data: { net: [{ bytesSent: 10, bytesRecv: 20, up: 999, down: 888 }] },
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const status = await testClient("net-prefer-live").systemUtilization();
  assert.equal(status.network_up_bytes, 10);
  assert.equal(status.network_down_bytes, 20);
});

test("systemUtilization skips net entries without counters", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v1/sys/utilization")
      return json(200, {
        data: { net: [{ name: "eno1" }, { bytesSent: 5, bytesRecv: 7 }] },
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const status = await testClient("net-sparse").systemUtilization();
  assert.equal(status.network_up_bytes, 5);
  assert.equal(status.network_down_bytes, 7);
});

test("systemUtilization returns undefined when no net entry has counters", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v1/sys/utilization")
      return json(200, { data: { net: [{ name: "eno1" }, null, "nope"] } });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const status = await testClient("net-empty").systemUtilization();
  assert.equal(status.network_up_bytes, undefined);
  assert.equal(status.network_down_bytes, undefined);
});

test("listApps maps a missing status key to unknown without throwing", async () => {
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v2/app_management/web/appgrid")
      return json(200, {
        data: [
          { name: "plex", status: "running" },
          { name: "mystery" }, // live shape: no status key
          { name: "handbrake", status: "exited" },
        ],
      });
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  const apps = await testClient("status-less").listApps();
  assert.equal(apps.length, 3);
  assert.equal(apps.find((a) => a.name === "mystery")?.status, "unknown");
  assert.equal(apps.find((a) => a.name === "handbrake")?.status, "exited");
});

// ---------------------------------------------------------------------------
// Security fixes: M1 (no default URL), M2 (self-apps guard), M3 (log shape).
// ---------------------------------------------------------------------------

test("M1: an unset CASAOS_API_URL fails closed and names the variable", () => {
  // The old code fell back to http://192.168.4.27, which both disclosed one
  // operator's LAN topology and aimed the password at a DHCP-reassignable IP.
  const err = (() => {
    try {
      assertCasaOSUrlAllowed("", false);
      return null;
    } catch (e) {
      return e as AppError;
    }
  })();
  assert.ok(err, "an empty URL must be rejected");
  assert.match(err.message, /CASAOS_API_URL is not set/);
  assert.equal(err.status, 503);
  // Whitespace-only is the same mistake and must not reach new URL().
  assert.throws(() => assertCasaOSUrlAllowed("   ", false), /CASAOS_API_URL is not set/);
});

test("M2: an app declared in CASAOS_SELF_APPS is refused under any built-in list", () => {
  const builtIn = ["openmuse", "tailscale", "casaos"];
  // The gap being closed: an install named "muse" matches nothing built in.
  assert.doesNotThrow(() => assertCasaOSAppAllowed(builtIn, "muse"));
  assert.throws(
    () => assertCasaOSAppAllowed(builtIn, "muse", ["muse"]),
    /protected/,
    "a self-declared app is refused",
  );
  // Case and surrounding whitespace are normalized, like the built-in path.
  assert.throws(() => assertCasaOSAppAllowed(builtIn, "  Muse  ", ["muse"]), /protected/);
  assert.throws(() => assertCasaOSAppAllowed(builtIn, "MUSE", ["muse"]), /protected/);
  // The built-in protections are unchanged, and an unrelated app still passes.
  assert.throws(() => assertCasaOSAppAllowed(builtIn, "openmuse", []), /protected/);
  assert.throws(() => assertCasaOSAppAllowed(builtIn, "openmuse-extra", []), /protected/);
  assert.doesNotThrow(() => assertCasaOSAppAllowed(builtIn, "plex", ["muse"]));
});

test("M3: appLogs returns a shape summary and no text unless opted in", async () => {
  const state = mockState();
  // A secret in a format the redactor cannot know about — exactly the M3 case.
  const secret = "Zx9-NotA-Known-Token-Format-Value";
  state.logsData = [
    "starting up",
    `connecting with MY_CUSTOM_KEY ${secret}`,
    "ERROR: could not bind port",
    "warning: disk almost full",
    "recovered",
  ].join("\n");
  fetchHandler = casaOSMock(state);

  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "shape-default",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
    // logToModel intentionally omitted: the default must be safe.
  });
  const result = await client.appLogs("plex");

  assert.deepEqual(result.lines, [], "no log text is returned by default");
  const summary = result.summary;
  assert.ok(summary, "a shape summary is returned instead");
  assert.equal(summary.lineCount, 5);
  assert.equal(summary.levels.error, 1);
  assert.equal(summary.levels.warning, 1);
  // 1-based line numbers of the error and warning lines.
  assert.deepEqual(summary.notableLines, [3, 4]);
  assert.equal(summary.truncated, false);
  // The decisive assertion: nothing from the log body may appear anywhere in
  // the serialized result, including in the summary fields.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret), `log text leaked to the model: ${serialized}`);
  assert.ok(!serialized.includes("starting up"), "line content leaked");
  assert.ok(!serialized.includes("could not bind port"), "error text leaked");
});

test("M3: CASAOS_LOG_TO_MODEL=true restores redacted text", async () => {
  const state = mockState();
  state.logsData = "plain line stays\npassword=hunter2\nERROR: boom";
  fetchHandler = casaOSMock(state);
  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "shape-optin",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
    logToModel: true,
  });
  const result = await client.appLogs("plex");
  assert.equal(result.summary, undefined);
  assert.equal(result.lines.length, 3);
  assert.ok(!result.lines.join("\n").includes("hunter2"), "still redacted when opted in");
});

test("M3: summarizeCasaOSLogs reports counts only and never any line content", () => {
  const summary = summarizeCasaOSLogs([
    "INFO all good",
    "Error: token abc123 rejected",
    "FATAL cannot continue",
    "errors are plural", // "errors" must not count as the "error" token
  ]);
  assert.equal(summary.lineCount, 4);
  // "error" counts only the whole-word line 2; "errors" on line 4 does not.
  assert.equal(summary.levels.error, 1);
  assert.equal(summary.levels.fatal, 1);
  assert.deepEqual(summary.notableLines, [2, 3]);
  assert.ok(!JSON.stringify(summary).includes("abc123"), "no content is included");
});

// ---------------------------------------------------------------------------
// L4: the token cache honours an expiry instead of holding a JWT indefinitely.
// ---------------------------------------------------------------------------

/** Build a JWT-shaped token whose `exp` is `secondsFromNow` from the clock. */
function jwtExpiringAt(secondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("L4: an expired cached token triggers a fresh login without waiting for a 401", async () => {
  const state = mockState();
  state.loginToken = jwtExpiringAt(-60); // already expired
  fetchHandler = casaOSMock(state);
  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "ttl-expired",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
  });

  await client.listApps(true);
  const afterFirst = state.logins.length;
  assert.equal(afterFirst, 1, "the first call logs in");
  await client.listApps(true);
  assert.equal(
    state.logins.length,
    afterFirst + 1,
    "the second call re-authenticates rather than reusing the expired token",
  );
  // The mock never returns a 401 on the appgrid: the expiry alone drove the
  // re-login, which is the point of L4.
  assert.equal(state.logins.length, 2, "exactly one extra login, no retry storm");
});

test("L4: a token that is still valid is reused, so the TTL adds no churn", async () => {
  const state = mockState();
  state.loginToken = jwtExpiringAt(3600);
  fetchHandler = casaOSMock(state);
  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "ttl-valid",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
  });
  await client.listApps(true);
  await client.listApps(true);
  await client.listApps(true);
  assert.equal(state.logins.length, 1, "a valid token is served from cache");
});

test("L4: an opaque, non-JWT token still gets a bounded cache lifetime", async () => {
  // CasaOS returns a JWT, but a proxy or a future version might not. Such a
  // token must still be cached (no per-call login) and must not throw.
  const state = mockState();
  state.loginToken = "opaque-token-value";
  fetchHandler = casaOSMock(state);
  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "ttl-opaque",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
  });
  await client.listApps(true);
  await client.listApps(true);
  assert.equal(state.logins.length, 1, "an opaque token is reused within its TTL");
});

test("L4: a JWT-shaped token whose payload is garbage is cached, not fatal", async () => {
  const state = mockState();
  state.loginToken = "aaa.!!!not-base64!!!.ccc";
  fetchHandler = casaOSMock(state);
  const client = new CasaOSClient({
    baseUrl: "http://127.0.0.1",
    owner: "ttl-garbage",
    loadCredentials: async () => ({ username: "u", password: "p", connectionId: "c1" }),
  });
  const apps = await client.listApps(true);
  assert.equal(apps.length, 4, "an unparseable payload does not break the read");
});

// ---------------------------------------------------------------------------
// L3: the post-PUT poll converges, and says so when it does not.
// ---------------------------------------------------------------------------

/** Count appgrid reads so a test can prove the loop stopped early. */
function pollCountingAppgrid(statusFor: (call: number) => string) {
  const state = mockState();
  const calls = { appgrid: 0 };
  fetchHandler = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/v1/users/login")
      return json(200, { data: { token: { access_token: "test-token" } } });
    if (u.pathname === "/v2/app_management/compose/plex/status" && init.method === "PUT")
      return json(200, { message: "compose app status is being changed asynchronously" });
    if (u.pathname === "/v2/app_management/web/appgrid") {
      calls.appgrid += 1;
      return json(200, {
        data: [
          { name: "plex", status: statusFor(calls.appgrid) },
          { name: "openmuse", status: "running" },
        ],
      });
    }
    throw new Error(`unexpected ${init.method} ${u.pathname}`);
  };
  return { state, calls };
}

async function executeStop(owner: string) {
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, config, owner, "admin", "right-password");
  const creds = await loadCasaOSCredentials(db, config, owner);
  const workspace = testWorkspace(db, config);
  return workspace.execute(
    owner,
    { kind: "casaos.action", data: { app: "plex", action: "stop" } },
    creds?.connectionId,
  );
}

test("L3: the poll stops as soon as the requested state is observed", async () => {
  // The app is already "exited" on the first poll after validateApp's read, so
  // the loop must not spend its remaining ~7s waiting for a state it has seen.
  const { calls } = pollCountingAppgrid(() => "exited");
  const result = await executeStop("l3-converged");
  assert.match(result, /Stop of "plex" was requested on CasaOS/);
  assert.match(result, /Current status: exited\./);
  assert.ok(
    !/expected "exited"/.test(result),
    "a converged poll must not be reported as a mismatch",
  );
  // One appgrid read for validateApp plus exactly one for the poll.
  assert.ok(calls.appgrid <= 2, `expected an early exit, saw ${calls.appgrid} appgrid reads`);
});

test("L3: a status contradicting the requested action is called out explicitly", async () => {
  // The user approved "Stop Plex" and the app is still running. The old message
  // reported "Current status: running" with nothing marking the contradiction.
  const { calls } = pollCountingAppgrid(() => "running");
  const result = await executeStop("l3-mismatch");
  assert.match(result, /Current status: running/);
  assert.match(
    result,
    /expected "exited" after this change/,
    "the mismatch is stated, not just implied",
  );
  // Having exhausted the loop rather than converged, it must have polled fully.
  assert.equal(calls.appgrid, 4, "validateApp plus all three polls");
});

test("M2: execution refuses a self-declared app even when the built-in list misses it", async () => {
  // End-to-end through workspace.execute, which re-checks the guard at execution
  // time: a "muse" install is refused when declared, allowed when not.
  const selfDeclared: Config = { ...config, casaosSelfApps: ["muse"] };
  const owner = "m2-selfapp";
  clearCasaOSTokenCache(owner);
  await saveCasaOSCredentials(db, selfDeclared, owner, "admin", "right-password");
  const creds = await loadCasaOSCredentials(db, selfDeclared, owner);
  const workspace = testWorkspace(db, selfDeclared);

  const refused = await workspace
    .execute(
      owner,
      { kind: "casaos.action", data: { app: "muse", action: "stop" } },
      creds?.connectionId,
    )
    .catch((e: Error) => e);
  assert.match(String((refused as Error).message), /protected/);

  // The same app under a config that does not declare it is not blocked by this
  // guard — the check is exactly as narrow as the operator's declaration.
  assert.doesNotThrow(() =>
    assertCasaOSAppAllowed(config.casaosProtectedApps, "muse", config.casaosSelfApps),
  );
});
