import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import type { TaskContext } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";
import { fixture as computerFixture } from "./helpers/computer.ts";
import { modelFixture } from "./helpers/model.ts";

type Page = { url: string; title: string; text: string };

/**
 * A minimal in-memory worker: it records the input the agent asked for and serves the
 * page each action should land on, so the tool guards are exercised end to end.
 */
function agentBrowser(
  t: Parameters<typeof browserFixture>[0],
  pages: Page[],
  inputs: { body: Record<string, unknown> }[],
) {
  let index = 0;
  let sessionId = "";
  const session = () => ({
    id: sessionId,
    url: pages[index].url,
    title: pages[index].title,
    status: "active",
    updatedAt: new Date().toISOString(),
  });
  return browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      sessionId = String(body.id);
      const match = pages.findIndex((page) => page.url === body.url);
      if (match >= 0) index = match;
      return { data: session() };
    }
    if (path.endsWith("/input")) {
      inputs.push({ body });
      const next = pages[Math.min(index + 1, pages.length - 1)];
      if (next.url !== pages[index].url) index = pages.findIndex((page) => page.url === next.url);
      return { data: session() };
    }
    if (path.endsWith("/read")) return { data: { ...pages[index], truncated: false } };
    throw new Error(`Unexpected browser path: ${path}`);
  });
}

test("a session that changes origin freezes input until the agent re-observes", async (t) => {
  const inputs: { body: Record<string, unknown> }[] = [];
  const browser = await agentBrowser(
    t,
    [
      { url: "https://shop.example/p/65w-charger", title: "65W USB-C Charger", text: "$19.99" },
      { url: "https://partner.example/redirect", title: "Partner page", text: "Redirecting" },
    ],
    inputs,
  );
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/p/65w-charger" } },
    { name: "browser_click", arguments: { x: 10, y: 10 } },
    // The click moved the session to another origin, so this must be refused.
    { name: "browser_scroll", arguments: { deltaY: 100 } },
    { name: "read_web", arguments: { url: "https://partner.example/redirect" } },
    { name: "browser_scroll", arguments: { deltaY: 200 } },
    { name: "finish_task", arguments: { summary: "Read both pages." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", {
    prompt: "Open the product page and read what it links to.",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.deepEqual(
    inputs.map((item) => item.body.type),
    ["click", "scroll"],
    "the frozen scroll never reached the worker; the one after re-observing did",
  );
  assert.equal(saved.evidence.filter((item) => item.kind === "browser_input").length, 2);
  assert.equal(saved.state.browserInputSpent, 2);
});

test("browser tools never clobber task state written earlier in the run", async (t) => {
  const inputs: { body: Record<string, unknown> }[] = [];
  const browser = await agentBrowser(
    t,
    [
      { url: "https://shop.example/catalogue", title: "Catalogue", text: "65W chargers" },
      { url: "https://shop.example/p/65w-charger", title: "65W USB-C Charger", text: "$19.99" },
    ],
    inputs,
  );
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/catalogue" } },
    { name: "browser_scroll", arguments: { deltaY: 400 } },
    { name: "browser_key", arguments: { key: "End" } },
    { name: "finish_task", arguments: { summary: "Read the listing." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Read the charger listing." });
  // Stand in for state a previous run persisted, including the cached() idempotency map
  // that must still be there after the browser tools checkpoint over it.
  const seeded = await app.agent.getTask("owner", task.id);
  await app.agent.db.put("owner", "tasks", {
    ...seeded,
    state: { ...seeded.state, carriedFromEarlierRun: "keep me", operations: { memo: "value" } },
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.state.carriedFromEarlierRun, "keep me");
  assert.deepEqual(saved.state.operations, { memo: "value" });
  assert.equal(saved.state.browserInputSpent, 2);
  assert.equal(saved.state.browserId, saved.state.browserId);
});

test("a failing worker cannot be retried into a loop without re-reading the page", async (t) => {
  const attempts: string[] = [];
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions")
      return {
        data: {
          id: String(body.id),
          url: "https://shop.example/p/65w-charger",
          title: "Charger",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    if (path.endsWith("/read"))
      return {
        data: {
          url: "https://shop.example/p/65w-charger",
          title: "Charger",
          text: "$19.99",
          truncated: false,
        },
      };
    if (path.endsWith("/input")) {
      attempts.push(path);
      return { status: 503, data: { error: { code: "WORKER_FAILURE", message: "Worker gone" } } };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  // Without a pause on uncertainty the model can retry the same action for the whole run.
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/p/65w-charger" } },
    { name: "browser_click", arguments: { x: 10, y: 10 } },
    { name: "browser_click", arguments: { x: 20, y: 20 } },
    { name: "browser_scroll", arguments: { deltaY: 100 } },
    { name: "ask_user", arguments: { question: "The browser is unavailable." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Open the product page." });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(attempts.length, 1, "only the first attempt reached the worker");
  assert.equal(
    saved.evidence.filter((item) => item.uncertain === true).length,
    1,
    "the refused retries are not recorded as page-reaching receipts",
  );
  assert.match(String(saved.state.browserInputUncertain), /^click: /);
});

test("a lost lease after a successful input is not reported as an uncertain outcome", async (t) => {
  const inputs: { body: Record<string, unknown> }[] = [];
  const browser = await agentBrowser(
    t,
    [
      { url: "https://shop.example/p/65w-charger", title: "65W USB-C Charger", text: "$19.99" },
      { url: "https://shop.example/cart", title: "Cart", text: "1 item" },
    ],
    inputs,
  );
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/p/65w-charger" } },
    { name: "browser_click", arguments: { x: 900, y: 700 } },
    { name: "finish_task", arguments: { summary: "Done." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const created = await app.agent.createTask("owner", { prompt: "Open the product page." });
  const task = await app.agent.getTask("owner", created.id);

  // Drop the lease once, when the receipt for a successful click would be written. A
  // later checkpoint succeeds, so anything written afterwards is genuinely persisted.
  let dropped = false;
  const patches: Partial<AgentTask>[] = [];
  const context: TaskContext = {
    signal: new AbortController().signal,
    guard: async () => {},
    event: async () => {},
    checkpoint: async (patch) => {
      patches.push(patch);
      const receipts = patch.evidence?.filter((item) => item.kind === "browser_input") ?? [];
      if (!dropped && receipts.length) {
        dropped = true;
        throw new Error("lease lost");
      }
      return { ...task, ...patch };
    },
  };

  await executeModelTask(app.agent, "owner", task, context);

  assert.equal(inputs.length, 1, "the action did reach the worker");
  const uncertainWrites = patches.filter((patch) =>
    patch.evidence?.some((item) => item.kind === "browser_input" && item.uncertain),
  );
  // The click reached the page and we know it did, so losing the lease afterwards must not
  // be recorded as an unknown outcome that the task has to go and re-read.
  assert.deepEqual(uncertainWrites, []);
});

test("the agent refuses to type credentials and routes sign-in to the user", async (t) => {
  const inputs: { body: Record<string, unknown> }[] = [];
  const browser = await agentBrowser(
    t,
    [{ url: "https://shop.example/login", title: "Sign in to your account", text: "Password" }],
    inputs,
  );
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/login" } },
    { name: "browser_type", arguments: { text: "my real password" } },
    { name: "browser_type", arguments: { text: "password: hunter2" } },
    { name: "ask_user", arguments: { question: "Please sign in yourself." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Check my saved addresses." });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.deepEqual(inputs, [], "no typed text ever reached the page");
  assert.equal(saved.evidence.filter((item) => item.kind === "browser_input").length, 0);
});

test("an input the worker fails is recorded as uncertain and is never replayed", async (t) => {
  let attempts = 0;
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions")
      return {
        data: {
          id: String(body.id),
          url: "https://shop.example/p/65w-charger",
          title: "Charger",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    if (path.endsWith("/read"))
      return {
        data: {
          url: "https://shop.example/p/65w-charger",
          title: "Charger",
          text: "$19.99",
          truncated: false,
        },
      };
    if (path.endsWith("/input")) {
      attempts++;
      // Simulate a dropped connection after the action may already have reached the page.
      return {
        status: 503,
        data: { error: { code: "WORKER_FAILURE", message: "Worker unavailable" } },
      };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/p/65w-charger" } },
    { name: "browser_click", arguments: { x: 10, y: 10 } },
    { name: "finish_task", arguments: { summary: "Reported the price." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Open the product page." });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(attempts, 1, "the failed input is never retried");
  const receipt = saved.evidence.find((item) => item.kind === "browser_input");
  assert.ok(receipt, "an uncertain attempt still leaves a durable receipt");
  assert.equal(receipt.uncertain, true);
  assert.match(receipt.excerpt, /Worker unavailable/);
  assert.match(String(saved.state.browserInputUncertain), /^click: /);
  assert.equal(saved.state.browserInputSpent, undefined, "an uncertain action is not respendable");
});

test("the agent can scroll and click a product page, and stops at checkout", async (t) => {
  const inputs: { body: Record<string, unknown> }[] = [];
  const browser = await agentBrowser(
    t,
    [
      { url: "https://shop.example/catalogue", title: "Catalogue", text: "65W chargers" },
      { url: "https://shop.example/p/65w-charger", title: "65W USB-C Charger", text: "$19.99" },
      { url: "https://shop.example/checkout", title: "Checkout", text: "Order summary" },
    ],
    inputs,
  );
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://shop.example/catalogue" } },
    { name: "browser_scroll", arguments: { deltaY: 600 } },
    { name: "browser_click", arguments: { x: 400, y: 300 } },
    { name: "browser_click", arguments: { x: 900, y: 700 } },
    { name: "finish_task", arguments: { summary: "Found the charger at $19.99." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", {
    prompt: "Find the cheapest 65W USB-C charger and report price and specs.",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  // Reaching checkout pauses for the user, and the next click is refused without
  // touching the page, so nothing was added to a cart.
  assert.equal(saved.status, "waiting_input");
  assert.match(String(saved.question), /purchase or reservation/);
  assert.deepEqual(
    inputs.map((item) => item.body.type),
    ["scroll", "click"],
  );
  const receipts = saved.evidence.filter((item) => item.kind === "browser_input");
  assert.equal(receipts.length, 2);
  assert.deepEqual(
    receipts.map((item) => item.action),
    ["scroll", "click"],
  );
  assert.equal(receipts[0].urlBefore, "https://shop.example/catalogue");
  assert.equal(receipts[0].urlAfter, "https://shop.example/p/65w-charger");
  assert.equal(receipts[1].urlBefore, "https://shop.example/p/65w-charger");
  assert.equal(receipts[1].urlAfter, "https://shop.example/checkout");
  assert.equal(
    receipts.every((item) => item.uncertain === false),
    true,
  );
  assert.equal(new Set(receipts.map((item) => item.id)).size, 2);
  assert.equal(saved.state.browserInputSpent, 2);
  assert.equal(
    saved.state.browserFrozen,
    false,
    "staying on the same site leaves the session interactive",
  );
});

test("CopilotKit model worker executes server tools and persists the confirmed outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-"));
  const db = await createStore();
  const calls: { name: string; arguments: object }[] = [
    {
      name: "set_plan",
      arguments: { steps: ["Inspect available sources", "Save a practical plan"] },
    },
    { name: "read_workspace", arguments: { section: "files" } },
    {
      name: "run_computer_command",
      arguments: { operationId: "check-working-directory", command: "pwd", cwd: "/workspace" },
    },
    {
      name: "save_artifact",
      arguments: {
        kind: "plan",
        title: "Weekend plan",
        summary: "A walk and time to read",
        data: { steps: ["Take a walk", "Read for 30 minutes"] },
      },
    },
    { name: "finish_task", arguments: { summary: "Saved your weekend plan with two steps." } },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(
    db,
    {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      intelligenceApiKey: "test-project-key-never-sent",
      model: "openai/fixture",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      computerEnabled: true,
    },
    { docker: computerFixture().runner },
  );
  try {
    const task = await server.agent.createTask("owner", {
      prompt: "Make a weekend plan",
      kind: "plan",
    });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.result, "Saved your weekend plan with two steps.");
    assert.ok(result.artifacts.some((a) => a.title === "Weekend plan"));
    assert.ok(
      result.events.some((event) => event.title === "Read the authorized workspace sources"),
    );
    assert.ok(requests.length >= 4 && requests.length <= 6);
    assert.ok(requests.every((request) => request.path === "/v1/responses"));
    assert.ok(requests[0].body.includes('"name":"prepare_email"'));
    assert.ok(requests[0].body.includes('"name":"run_computer_command"'));
    assert.ok(
      requests.some(
        (request) => request.body.includes("succeeded") && request.body.includes("hello"),
      ),
    );
    assert.equal((await server.computer.snapshot("owner")).commands[0]?.status, "succeeded");
    assert.ok(!requests[0].body.includes('"name":"approve"'));
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "prepare_event",
      arguments: {
        title: "Sample walk",
        start: "2026-10-10T10:00:00-07:00",
        end: "2026-10-10T11:00:00-07:00",
      },
    });
    const appointment = await server.agent.createTask("owner", {
      prompt: "Prepare a sample walk on my calendar",
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("owner", appointment.id);
    assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
    assert.ok(pending.actionId);
    const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId);
    assert.ok(proposal);
    await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "finish_task",
      arguments: { summary: "The reviewed sample event is on the calendar." },
    });
    await server.agent.worker.tick();
    const finished = await server.agent.getTask("owner", appointment.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.ok(requests[0].body.includes("approvalResult"));
    assert.equal(
      (await db.list<ActionProposal>("owner", "actions")).filter((a) => a.taskId === appointment.id)
        .length,
      1,
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model worker keeps the text a model replies with when it calls no tool", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-text-"));
  const db = await createStore();
  const mock = createDemoModel({ latency: 0, firstByteDelay: 0 });
  await mock.start();
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-demo-test";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await mock.stop();
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: demoModel,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "waiting_input");
    assert.match(String(result.task.state.lastUpdate), /Find cool stuff on Hacker News/);
    assert.ok(
      result.events.some(
        (event) =>
          event.title === "Agent update" && /Find cool stuff on Hacker News/.test(event.detail),
      ),
      "the reply is recorded in the task timeline",
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaying a completed prepared action returns its receipt without reopening approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-replay-"));
  const db = await createStore();
  const draft = {
    title: "Sample walk",
    start: "2026-10-10T10:00:00-07:00",
    end: "2026-10-10T11:00:00-07:00",
  };
  let calls: ({ name: string; arguments: object } | undefined)[] = [
    { name: "prepare_event", arguments: draft },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("replay-owner", {
      prompt: "Put a sample walk on my calendar",
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("replay-owner", task.id);
    assert.equal(pending.status, "waiting_approval");
    assert.ok(pending.actionId);
    const proposal = await db.get<ActionProposal>("replay-owner", "actions", pending.actionId);
    assert.ok(proposal);
    const completed = await server.actions.decide(
      "replay-owner",
      proposal.id,
      proposal.hash,
      "approve",
    );
    assert.equal(completed.status, "succeeded");

    requests.length = 0;
    calls = [
      { name: "prepare_event", arguments: draft },
      { name: "finish_task", arguments: { summary: "The reviewed event is already complete." } },
    ];
    await server.agent.worker.tick();

    const finished = await server.agent.getTask("replay-owner", task.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.equal(finished.state.approvalResult, completed.result);
    const actions = (await db.list<ActionProposal>("replay-owner", "actions")).filter(
      (action) => action.taskId === task.id,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, "succeeded");
    assert.ok(requests.some((request) => request.body.includes(String(completed.result))));
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser reads keep observation identity distinct while reusing one session", async (t) => {
  let currentUrl = "https://example.com/one";
  const sessionIds = new Set<string>();
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      const id = String(body.id);
      currentUrl = String(body.url);
      sessionIds.add(id);
      return {
        data: {
          id,
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read")) {
      return {
        data: {
          url: currentUrl,
          title: currentUrl.endsWith("/one") ? "Source one" : "Source two",
          text: `Evidence from ${currentUrl}`,
          truncated: false,
        },
      };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://example.com/one" } },
    { name: "read_web", arguments: { url: "https://example.com/two" } },
    { name: "finish_task", arguments: { summary: "Compared both public sources." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());

  const task = await app.agent.createTask("owner", {
    prompt: "Read both public sources and compare them.",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  const webEvidence = saved.evidence.filter((item) => item.kind === "web");
  assert.equal(webEvidence.length, 2);
  assert.deepEqual(
    webEvidence.map((item) => item.url),
    ["https://example.com/one", "https://example.com/two"],
  );
  assert.equal(sessionIds.size, 1, "both reads should reuse the same browser session");
  assert.equal(new Set(webEvidence.map((item) => item.id)).size, 2);
});
