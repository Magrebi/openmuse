import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { applyEnvValues, parseEnvFile, summarizePlan } from "../src/envfile.js";
import type { RandomBytes } from "../src/secrets.js";
import { randomToken } from "../src/secrets.js";
import {
  intelligenceStep,
  modelSpecSchema,
  modelStep,
  providerKeyName,
  providers,
  secretStatuses,
  secretsStep,
  wizardPlan,
  wizardSteps,
} from "../src/wizard.js";

const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

/** Production generation uses the OS CSPRNG, as the wizard does at runtime. */
const real = (): RandomBytes => (length) => crypto.getRandomValues(new Uint8Array(length));

/** A `.env` that already carries a complete, valid set of secrets. */
const configured = (): string =>
  applyEnvValues(example, {
    OPENMUSE_ACCESS_KEY: randomToken(32, real()),
    TOKEN_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    ),
    WORKER_TOKEN: randomToken(32, real()),
  });

test("the wizard runs the documented steps in order", () => {
  assert.deepEqual([...wizardSteps], ["prerequisites", "secrets", "model", "verify"]);
  assert.deepEqual([...providers], ["openai", "anthropic", "google"]);
});

test("a first run generates every secret and writes a valid .env", () => {
  const step = secretsStep(example, real());
  assert.deepEqual(Object.keys(step.updates).sort(), [
    "OPENMUSE_ACCESS_KEY",
    "TOKEN_ENCRYPTION_KEY",
    "WORKER_TOKEN",
  ]);
  assert.equal(step.generated?.OPENMUSE_ACCESS_KEY.length, 32);
  assert.match(step.generated?.TOKEN_ENCRYPTION_KEY ?? "", /^[A-Za-z0-9+/]{43}=$/);
  assert.ok((step.generated?.WORKER_TOKEN.length ?? 0) >= 32);

  const written = applyEnvValues(example, step.updates);
  const parsed = parseEnv(written);
  // Node's own parser must accept it, because apps/server loads .env this way.
  assert.equal(parsed.OPENMUSE_ACCESS_KEY, step.generated?.OPENMUSE_ACCESS_KEY);
  assert.equal(parsed.WORKER_TOKEN, step.generated?.WORKER_TOKEN);
  for (const status of secretStatuses(parseEnvFile(written)))
    assert.equal(status.status, "present", `${status.key} is usable`);
});

test("re-running the wizard preserves existing secrets", () => {
  const current = configured();
  const before = parseEnvFile(current);
  const step = secretsStep(current, real());
  assert.deepEqual(step.updates, {}, "a complete .env needs nothing new");
  assert.equal(step.generated, null);
  assert.deepEqual(step.replaces, []);
  assert.equal(applyEnvValues(current, step.updates), current, "the file is untouched");
  assert.equal(parseEnvFile(current).OPENMUSE_ACCESS_KEY, before.OPENMUSE_ACCESS_KEY);
});

test("a re-run repairs only the broken secret", () => {
  const current = applyEnvValues(configured(), { WORKER_TOKEN: "" });
  const step = secretsStep(current, real());
  assert.deepEqual(Object.keys(step.updates), ["WORKER_TOKEN"]);
  assert.deepEqual(step.preserved.sort(), ["OPENMUSE_ACCESS_KEY", "TOKEN_ENCRYPTION_KEY"]);
  const after = parseEnvFile(applyEnvValues(current, step.updates));
  for (const status of secretStatuses(after)) assert.equal(status.status, "present");
});

test("a secret too short to satisfy the server is reported as such", () => {
  const statuses = secretStatuses({
    OPENMUSE_ACCESS_KEY: "short",
    TOKEN_ENCRYPTION_KEY: "not-base64",
    WORKER_TOKEN: "",
  });
  const statusOf = (key: string) => statuses.find((entry) => entry.key === key)?.status;
  assert.equal(statusOf("OPENMUSE_ACCESS_KEY"), "too-short");
  assert.equal(statusOf("TOKEN_ENCRYPTION_KEY"), "malformed");
  assert.equal(statusOf("WORKER_TOKEN"), "missing");
  // Every problem comes with one line the person can act on.
  for (const entry of statuses) {
    if (entry.status !== "present") assert.ok(entry.fix && !entry.fix.includes("\n"));
  }
});

test("regenerating a secret is explicit, reported, and replaces the old value", () => {
  const current = configured();
  const before = parseEnvFile(current).WORKER_TOKEN;
  const step = secretsStep(current, real(), ["WORKER_TOKEN"]);
  assert.deepEqual(step.replaces, ["WORKER_TOKEN"], "the caller must confirm this");
  const after = parseEnvFile(applyEnvValues(current, step.updates));
  assert.notEqual(after.WORKER_TOKEN, before);
  assert.equal(after.OPENMUSE_ACCESS_KEY, parseEnvFile(current).OPENMUSE_ACCESS_KEY);
});

test("no secret value ever appears in the plan summary", () => {
  const step = secretsStep(example, real());
  const summary = summarizePlan(wizardPlan(example, step.updates));
  for (const value of Object.values(step.updates)) assert.ok(!summary.includes(value));
  assert.match(summary, /OPENMUSE_ACCESS_KEY = \(set\)/);
});

test("a model choice writes MODEL and the provider's own key", () => {
  const step = modelStep(example, {
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    apiKey: "sk-ant-paste-me",
  });
  assert.equal(step.model, "anthropic/claude-sonnet-4.5");
  assert.deepEqual(step.updates, {
    MODEL: "anthropic/claude-sonnet-4.5",
    ANTHROPIC_API_KEY: "sk-ant-paste-me",
  });
  // A full spec is accepted as typed, and a gateway id keeps its inner slashes.
  assert.equal(
    modelStep("", { provider: "openai", model: "openai/vendor/model", apiKey: "sk-x" }).model,
    "openai/vendor/model",
  );
  for (const provider of providers)
    assert.equal(providerKeyName[provider], `${provider.toUpperCase()}_API_KEY`);
});

test("a model that disagrees with the chosen provider is refused", () => {
  assert.throws(
    () => modelStep("", { provider: "openai", model: "anthropic/claude", apiKey: "sk-x" }),
    { name: "DesktopError", code: "ENV_INVALID" },
  );
  assert.throws(() => modelStep("", { provider: "openai", model: "gpt-5", apiKey: "  " }), {
    code: "ENV_INVALID",
  });
  for (const invalid of ["", "gpt-5", "/gpt-5", "openai/"])
    assert.throws(() => modelSpecSchema(invalid), { code: "ENV_INVALID" });
});

test("a provider key already in .env is preserved until it is pasted again", () => {
  const current = applyEnvValues(example, { OPENAI_API_KEY: "sk-existing" });
  const same = modelStep(current, { provider: "openai", model: "gpt-5", apiKey: "sk-existing" });
  assert.deepEqual(same.updates, { MODEL: "openai/gpt-5" }, "the key is not rewritten");
  const rotated = modelStep(current, { provider: "openai", model: "gpt-5", apiKey: "sk-new" });
  assert.equal(rotated.updates.OPENAI_API_KEY, "sk-new");
});

test("the Intelligence key lands in .env and is never rewritten unchanged", () => {
  const first = intelligenceStep(example, " cpk_live_abc123 \n");
  assert.deepEqual(first, { CPK_INTELLIGENCE_API_KEY: "cpk_live_abc123" });
  const current = applyEnvValues(example, first);
  assert.deepEqual(intelligenceStep(current, "cpk_live_abc123"), {});
  assert.throws(() => intelligenceStep(example, "   "), { code: "ENV_INVALID" });
});

test("a generated .env covers every key the wizard promises", () => {
  const step = secretsStep(example, real());
  const model = modelStep(example, { provider: "openai", model: "gpt-5", apiKey: "sk-openai" });
  const written = applyEnvValues(
    applyEnvValues(example, { ...step.updates, ...model.updates }),
    intelligenceStep(example, "cpk_live_abc123"),
  );
  const parsed = parseEnv(written);
  assert.equal(parsed.MODEL, "openai/gpt-5");
  assert.equal(parsed.OPENAI_API_KEY, "sk-openai");
  assert.equal(parsed.CPK_INTELLIGENCE_API_KEY, "cpk_live_abc123");
  // The example's guidance is preserved so the file still explains itself.
  assert.ok(written.includes("# Browser worker (separate from the task worker):"));
});
