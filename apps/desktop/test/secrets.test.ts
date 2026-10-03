import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  accessKeyLength,
  cryptoRandomBytes,
  generateSecrets,
  type RandomBytes,
  randomEncryptionKey,
  randomToken,
  redact,
} from "../src/secrets.js";

test("generated secrets meet the server's minimum lengths", () => {
  const secrets = generateSecrets(cryptoRandomBytes);
  // apps/server requires OPENMUSE_ACCESS_KEY >= 24 characters.
  assert.ok(secrets.OPENMUSE_ACCESS_KEY.length >= 24);
  assert.equal(secrets.OPENMUSE_ACCESS_KEY.length, accessKeyLength);
  // The browser worker requires WORKER_TOKEN of at least 32 characters.
  assert.ok(secrets.WORKER_TOKEN.length >= 32);
  // TOKEN_ENCRYPTION_KEY must decode to 32 bytes.
  assert.equal(Buffer.from(secrets.TOKEN_ENCRYPTION_KEY, "base64").length, 32);
});

test("generated values are high entropy, not a repeated pattern", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = randomToken(32, cryptoRandomBytes);
    assert.equal(token.length, 32);
    // A 32-character draw from a 30-character alphabet cannot repeat meaningfully.
    assert.ok(new Set(token).size >= 10, "a random token should not repeat a few characters");
    seen.add(token);
  }
  assert.equal(seen.size, 200, "every generated token must be unique");
});

test("rejection sampling keeps the alphabet unambiguous", () => {
  // The alphabet omits O/0 and I/l/1 so a key can be read aloud.
  const sample = randomToken(4000, cryptoRandomBytes);
  assert.ok(!/[O0Il1]/.test(sample), "no ambiguous characters");
  assert.ok(/^[A-HJ-NP-Z2-9]+$/.test(sample), `unexpected character in ${sample}`);
});

test("a deterministic source is accepted for tests", () => {
  const zero: RandomBytes = (n) => new Uint8Array(n);
  assert.equal(randomToken(16, zero), "A".repeat(16));
  assert.equal(randomEncryptionKey(zero), Buffer.alloc(32).toString("base64"));
});

test("secrets never appear in redacted output", () => {
  const secrets = generateSecrets(cryptoRandomBytes);
  const captured = [
    `WORKER_TOKEN=${secrets.WORKER_TOKEN}`,
    `env OPENMUSE_ACCESS_KEY=${secrets.OPENMUSE_ACCESS_KEY} exported`,
    `error: failed with token ${secrets.WORKER_TOKEN} in output`,
  ].join("\n");
  const safe = redact(captured, Object.values(secrets));
  for (const secret of Object.values(secrets))
    assert.ok(!safe.includes(secret), `secret leaked: ${secret.slice(0, 6)}…`);
  // The surrounding context is preserved so the log stays useful.
  assert.ok(safe.includes("[redacted]"));
});

test("redaction also masks unknown KEY=value pairs", () => {
  const safe = redact("CPK_INTELLIGENCE_API_KEY=pk-live-abc123 GOOGLE_CLIENT_SECRET=shh");
  assert.ok(!safe.includes("pk-live-abc123"));
  assert.ok(!safe.includes("shh"));
});

test("redaction does not mangle ordinary log lines", () => {
  const line = "OpenMuse sample API ready at http://localhost:8787";
  assert.equal(redact(line, []), line);
  assert.equal(redact(line, Object.values(generateSecrets(cryptoRandomBytes))), line);
});

test("a secret too short to be a real key is left alone", () => {
  // Redacting every 2-letter substring would corrupt the log viewer.
  assert.equal(redact("port 80 is up", ["80"]), "port 80 is up");
});

test("different runs do not produce the same secrets", () => {
  const a = generateSecrets(cryptoRandomBytes);
  const b = generateSecrets(cryptoRandomBytes);
  const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex");
  assert.notEqual(fingerprint(a.WORKER_TOKEN), fingerprint(b.WORKER_TOKEN));
});
