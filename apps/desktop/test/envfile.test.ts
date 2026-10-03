import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseEnv } from "node:util";
import {
  applyEnvValues,
  exampleKeys,
  parseEnvFile,
  planEnvUpdate,
  summarizePlan,
} from "../src/envfile.js";

const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

test("the wizard generates a valid .env from the example's keys", () => {
  const keys = exampleKeys(example).map((entry) => entry.key);
  for (const required of [
    "WORKER_TOKEN",
    "TOKEN_ENCRYPTION_KEY",
    "OPENMUSE_ACCESS_KEY",
    "MODEL",
    "CPK_INTELLIGENCE_API_KEY",
  ])
    assert.ok(keys.includes(required), `${required} is documented in .env.example`);
  assert.ok(keys.length > 10);
});

test("a generated .env is readable by Node's own env parser", () => {
  // apps/server uses process.loadEnvFile, so our quoting must match Node.
  const written = applyEnvValues(example, {
    WORKER_TOKEN: "a-token-with-spaces and #hash",
    OPENMUSE_ACCESS_KEY: "abcdefghijklmnopqrstuvwx",
  });
  const parsed = parseEnv(written);
  assert.equal(parsed.WORKER_TOKEN, "a-token-with-spaces and #hash");
  assert.equal(parsed.OPENMUSE_ACCESS_KEY, "abcdefghijklmnopqrstuvwx");
});

test("comments and layout survive an edit so the diff stays reviewable", () => {
  const after = applyEnvValues(example, { MODEL: "openai/gpt-5" });
  assert.ok(after.includes("# Browser worker (separate from the task worker):"));
  assert.ok(after.includes("WORKSPACE_MODE=sample"));
  assert.ok(!/\n{3,}/.test(after), "no blank-line pileup");
  assert.ok(after.endsWith("\n"));
});

test("a commented example becomes a real assignment once it is set", () => {
  const after = applyEnvValues(example, { WORKER_TOKEN: "worker-secret-value" });
  assert.ok(after.includes("WORKER_TOKEN='worker-secret-value'"));
  assert.ok(!after.includes("# WORKER_TOKEN="));
});

test("re-running the wizard preserves existing secrets", () => {
  const first = applyEnvValues(example, { WORKER_TOKEN: "original-worker-token" });
  const second = applyEnvValues(first, { MODEL: "anthropic/claude" });
  assert.ok(second.includes("original-worker-token"), "an existing secret is not regenerated");
  assert.equal(parseEnvFile(second).WORKER_TOKEN, "original-worker-token");
});

test("a plan reports what changes and never shows secret values", () => {
  const plan = planEnvUpdate(example, {
    WORKER_TOKEN: "fresh-worker-token",
    MODEL: "openai/gpt-5",
  });
  assert.deepEqual(plan.changes.map((change) => change.key).sort(), ["MODEL", "WORKER_TOKEN"]);
  // The example has these commented out, so this is a fresh set, not an overwrite.
  assert.equal(plan.overwrites, false);
  const summary = summarizePlan(plan);
  assert.ok(!summary.includes("fresh-worker-token"), "the summary must not print a secret");
  assert.ok(summary.includes("MODEL = openai/gpt-5"), "a non-secret change is visible");
});

test("an unchanged update produces an empty plan", () => {
  const plan = planEnvUpdate("MODEL=openai/gpt-5\n", { MODEL: "openai/gpt-5" });
  assert.deepEqual(plan.changes, []);
  assert.equal(summarizePlan(plan), "No changes.");
});

test("parser ignores comments and blank lines and unwraps quotes", () => {
  const parsed = parseEnvFile(
    "# a comment\n\nMODEL=openai/gpt-5\nQUOTED='has space'\nDUP=\"quoted\"\nnot a pair\n1BAD=x\nEMPTY=\n",
  );
  assert.deepEqual(parsed, {
    MODEL: "openai/gpt-5",
    QUOTED: "has space",
    DUP: "quoted",
    EMPTY: "",
  });
});
