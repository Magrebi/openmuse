import { DesktopError } from "./errors.js";

/** Injected so the app uses the OS CSPRNG and tests can be deterministic. */
export type RandomBytes = (length: number) => Uint8Array;

/** Web Crypto, present in the Tauri webview and in Node 22+. */
export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

// Unambiguous alphabet: no O/0, I/l/1. A person may read a key aloud or retype it.
const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Rejection sampling keeps every character equally likely. */
export function randomToken(length: number, randomBytes: RandomBytes): string {
  if (!Number.isInteger(length) || length < 16)
    throw new DesktopError("ENV_INVALID", "A generated secret must be at least 16 characters");
  const limit = 256 - (256 % alphabet.length);
  let token = "";
  while (token.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      token += alphabet[byte % alphabet.length];
      if (token.length === length) break;
    }
  }
  return token;
}

export const randomPassword = (randomBytes: RandomBytes): string => randomToken(32, randomBytes);

/** Base64 without Buffer, which the Tauri webview does not provide. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 32 random bytes encoded as base64, matching the server's TOKEN_ENCRYPTION_KEY. */
export const randomEncryptionKey = (randomBytes: RandomBytes): string => toBase64(randomBytes(32));

/** The access key must clear the server's 24-character minimum. */
export const accessKeyLength = 32;

export interface GeneratedSecrets {
  readonly OPENMUSE_ACCESS_KEY: string;
  readonly TOKEN_ENCRYPTION_KEY: string;
  readonly WORKER_TOKEN: string;
}

export function generateSecrets(randomBytes: RandomBytes): GeneratedSecrets {
  return {
    OPENMUSE_ACCESS_KEY: randomToken(accessKeyLength, randomBytes),
    TOKEN_ENCRYPTION_KEY: randomEncryptionKey(randomBytes),
    WORKER_TOKEN: randomPassword(randomBytes),
  };
}

/** Keys whose values must never be printed, logged, or placed in an argv. */
export const secretKeys = [
  "OPENMUSE_ACCESS_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "WORKER_TOKEN",
  "CPK_INTELLIGENCE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "AGENT_TOKEN",
  "TYPESAFE_API_KEY",
  "DATABASE_URL",
] as const;

/**
 * Remove secrets from text bound for a log file or the log viewer. Compose
 * echoes its resolved environment on some failures, so this runs on every
 * captured chunk rather than trusting the source.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const value of [...secrets].filter(Boolean)) {
    if (value.length < 8) continue;
    output = output.split(value).join("[redacted]");
  }
  // Also mask `KEY=value` assignments, which catches secrets the caller did not
  // enumerate and values written into a compose override.
  output = output.replace(
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*\S+/g,
    "$1=[redacted]",
  );
  return output;
}
