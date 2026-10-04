import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import { type CasaOSCredentials, clearCasaOSTokenCache, verifyCasaOSLogin } from "./casaos.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * CasaOS credential store. Mirrors the google-auth.ts pattern:
 * - A live login happens BEFORE anything is written (wrong password never stores).
 * - The secret blob ({username, password}) is encrypted with TOKEN_ENCRYPTION_KEY
 *   via vault.ts and stored at db.put(owner, "credentials", "casaos").
 * - Each save generates a fresh connectionId, so decide() invalidates reviews
 *   prepared under a previous connection.
 * - The password is decrypted into server memory only: this module does not
 *   log it, does not store it in plaintext, and sends it out of the server
 *   only inside the CasaOS login request itself. (Over a plain-HTTP
 *   CASAOS_API_URL that request is unencrypted on the network — see the
 *   transport policy in casaos.ts and CASAOS_ALLOW_INSECURE_HTTP.)
 */

interface StoredCasaOSCredential {
  id: string;
  connectionId: string;
  secret: string;
}

export async function saveCasaOSCredentials(
  db: Store,
  config: Config,
  owner: string,
  username: string,
  password: string,
): Promise<{ connectionId: string }> {
  if (!config.encryptionKey)
    throw new AppError("Set TOKEN_ENCRYPTION_KEY and restart the API to connect CasaOS.", 503);
  // Live login first: nothing is stored unless CasaOS accepts the credentials.
  await verifyCasaOSLogin(
    config.casaosApiUrl,
    username,
    password,
    config.casaosAllowInsecureHttp ?? false,
  );
  const connectionId = randomUUID();
  const stored: StoredCasaOSCredential = {
    id: "casaos",
    connectionId,
    secret: encryptSecret(JSON.stringify({ username, password }), config.encryptionKey),
  };
  await db.put(owner, "credentials", stored);
  clearCasaOSTokenCache(owner);
  return { connectionId };
}

export async function loadCasaOSCredentials(
  db: Store,
  config: Config,
  owner: string,
): Promise<CasaOSCredentials | null> {
  const stored = await db.get<StoredCasaOSCredential>(owner, "credentials", "casaos");
  if (stored?.id !== "casaos" || !stored.secret || !stored.connectionId) return null;
  if (!config.encryptionKey) return null;
  try {
    const parsed = JSON.parse(decryptSecret(stored.secret, config.encryptionKey)) as {
      username?: unknown;
      password?: unknown;
    };
    if (
      typeof parsed.username !== "string" ||
      !parsed.username ||
      typeof parsed.password !== "string" ||
      !parsed.password
    )
      return null;
    return {
      username: parsed.username,
      password: parsed.password,
      connectionId: stored.connectionId,
    };
  } catch {
    // Rotated key or corrupt record: treated as not configured, never half-read.
    return null;
  }
}

export async function casaOSCredentialsConfigured(
  db: Store,
  config: Config,
  owner: string,
): Promise<boolean> {
  return (await loadCasaOSCredentials(db, config, owner)) !== null;
}

export async function clearCasaOSCredentials(db: Store, owner: string): Promise<void> {
  await db.remove(owner, "credentials", "casaos");
  clearCasaOSTokenCache(owner);
}
