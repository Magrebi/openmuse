import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key) {
    throw new Error("Credential encryption requires a 32-byte base64 key");
  }
  return bytes;
}

/**
 * The additional authenticated data every credential envelope is bound to.
 *
 * A constant, and deliberately so: it is the one value that cannot change
 * without invalidating every credential already encrypted on disk. Per-slot
 * binding (`owner` + `connectionId` + `generation`) is the correct end state
 * and is deferred — see REVIEW.md (L6) and the substitution test in
 * `tests/vault.test.ts`, which pins the current behaviour so the constant
 * cannot be edited without that being noticed.
 *
 * Accepted as an explicit parameter only so the eventual migration is a
 * mechanical change at the call sites rather than a rewrite of the envelope
 * format. Every caller today omits it and gets exactly these bytes.
 */
const DEFAULT_AAD = Buffer.from("openmuse:credential:v1");

/** Versioned AES-256-GCM envelope: version.nonce.tag.ciphertext. */
export function encryptSecret(
  plaintext: string,
  key: string,
  aad: Buffer = DEFAULT_AAD,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(
  encrypted: string,
  key: string,
  aad: Buffer = DEFAULT_AAD,
): string {
  const keyBytes = decodeKey(key);
  const [version, nonceString, tagString, ciphertextString, extra] = encrypted.split(".");
  if (
    version !== "v1" ||
    nonceString === undefined ||
    tagString === undefined ||
    ciphertextString === undefined ||
    extra !== undefined
  ) {
    throw new Error("Invalid encrypted secret");
  }
  const encoded = [nonceString, tagString, ciphertextString];
  const [nonce, tag, ciphertext] = encoded.map((value) => Buffer.from(value, "base64url"));
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    encoded.some(
      (value, index) => Buffer.from(value, "base64url").toString("base64url") !== encoded[index],
    )
  ) {
    throw new Error("Invalid encrypted secret");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to authenticate or decrypt credential");
  }
}
