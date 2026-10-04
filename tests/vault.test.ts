import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../packages/integrations/src/vault.ts";

test("vault encrypts with a fresh nonce and authenticates the entire envelope", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(decryptSecret(first, key), secret);
  assert.throws(
    () => decryptSecret(first, randomBytes(32).toString("base64")),
    /authenticate|decrypt/i,
  );
  const parts = first.split(".");
  assert.equal(parts.length, 4);
  for (let index = 1; index < 4; index++) {
    const corrupted = [...parts];
    const bytes = Buffer.from(corrupted[index], "base64url");
    bytes[0] ^= 1;
    corrupted[index] = bytes.toString("base64url");
    assert.throws(() => decryptSecret(corrupted.join("."), key), /authenticate|decrypt/i);
  }
});

test("vault rejects malformed keys and envelopes without echoing secrets", () => {
  for (const key of [
    "",
    "password",
    randomBytes(31).toString("base64"),
    `${randomBytes(32).toString("base64")}!`,
  ]) {
    assert.throws(() => encryptSecret("secret-value", key), /32-byte base64/i);
  }
  const key = randomBytes(32).toString("base64");
  for (const envelope of ["", "plaintext-secret", "v2.a.b.c", "v1.!.a.b", "v1.a.b.c.extra"]) {
    assert.throws(() => decryptSecret(envelope, key), /invalid encrypted secret/i);
  }
  assert.equal(decryptSecret(encryptSecret("", key), key), "");
});

test("cross-slot substitution still decrypts: the constant AAD deferral is pinned", () => {
  // This documents a KNOWN LIMITATION rather than endorsing it. `vault.ts`
  // authenticates every envelope against one constant AAD instead of binding
  // each ciphertext to its own owner/connection, so a ciphertext copied from one
  // owner's credential slot into another's decrypts and authenticates as valid.
  //
  // Hardening it is deliberately deferred: changing the AAD would invalidate
  // every credential already encrypted on disk, and `TOKEN_ENCRYPTION_KEY` is
  // not recoverable by the person who set it. REVIEW.md (L6) records it.
  //
  // The value of this test is that the deferral cannot drift silently. If
  // someone changes the AAD constant, this fails — and whoever changes it is
  // forced to confront that they are invalidating live credentials. When
  // per-credential AAD ships, THIS test is what gets inverted: it must come to
  // assert that the cross-slot decryption throws.
  const key = randomBytes(32).toString("base64");
  const secretA = JSON.stringify({ token: "owner-a-token", connectionId: "conn-1" });
  const secretB = JSON.stringify({ token: "owner-b-token", connectionId: "conn-2" });

  const envelopeA = encryptSecret(secretA, key);
  const envelopeB = encryptSecret(secretB, key);

  // Each owner's own envelope round-trips, as it always has.
  assert.equal(decryptSecret(envelopeA, key), secretA);
  assert.equal(decryptSecret(envelopeB, key), secretB);

  // And the substitution that must not be possible, yet is: owner A's
  // ciphertext, read as though it were owner B's.
  const substituted = decryptSecret(envelopeA, key);
  assert.equal(substituted, secretA);
  assert.notEqual(substituted, secretB);

  // Substituting the ciphertext alone does not help an attacker who does not
  // hold the key: a different key still fails to authenticate. The exposure is
  // slot binding, not the confidentiality of the key.
  assert.throws(
    () => decryptSecret(envelopeA, randomBytes(32).toString("base64")),
    /authenticate|decrypt/i,
  );
});

test("the AAD parameter defaults to the shipping constant and is honoured when given", () => {
  // The optional `aad` argument must be a no-op for every existing caller: the
  // ciphertext format, the envelope version, and the authenticated bytes all
  // stay exactly as they were, or every credential already on disk would fail
  // to decrypt. Passing the default explicitly must be indistinguishable from
  // passing nothing.
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const legacy = Buffer.from("openmuse:credential:v1");

  // The default decrypts what the default encrypted, and the explicitly
  // supplied identical AAD decrypts it too — the two paths agree.
  const envelope = encryptSecret(secret, key);
  assert.equal(decryptSecret(envelope, key), secret);
  assert.equal(decryptSecret(envelope, key, legacy), secret);

  // A ciphertext written with a non-default AAD only decrypts with that AAD.
  // This is the mechanism the deferred v2 migration will use; today it proves
  // the plumbing works without any credential being migrated.
  const scoped = Buffer.from("openmuse:credential:v2:owner-a:conn-1");
  const scopedEnvelope = encryptSecret(secret, key, scoped);
  assert.equal(decryptSecret(scopedEnvelope, key, scoped), secret);
  assert.throws(
    () => decryptSecret(scopedEnvelope, key),
    /authenticate|decrypt/i,
    "a scoped envelope must not open with the constant AAD",
  );
  assert.throws(
    () => decryptSecret(scopedEnvelope, key, Buffer.from("openmuse:credential:v2:owner-b:conn-1")),
    /authenticate|decrypt/i,
    "nor with another owner's scope",
  );

  // The envelope format is unchanged: still four dot-separated v1 components.
  assert.equal(scopedEnvelope.split(".").length, 4);
  assert.equal(scopedEnvelope.split(".")[0], "v1");
});
