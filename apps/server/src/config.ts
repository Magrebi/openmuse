import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { assertValidEncryptionKey } from "../../../packages/integrations/src/vault.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  allowedOrigins: string[];
  /**
   * Largest single library document accepted, in bytes, from `LIBRARY_MAX_FILE_MB`.
   * Optional so a Config assembled without it (tests, embedded callers) still
   * typechecks; `libraryLimits` applies the documented defaults.
   */
  libraryMaxFileBytes?: number;
  /**
   * Largest total library size per owner, in bytes, from `LIBRARY_MAX_TOTAL_MB`.
   * Same optional-with-default shape as `libraryMaxFileBytes`.
   */
  libraryMaxTotalBytes?: number;
  /** OCR language codes, from `LIBRARY_OCR_LANGS`. Default `eng+tur`. */
  libraryOcrLangs?: string;
  /** Scanned pages OCR'd per document, from `LIBRARY_OCR_MAX_PAGES`. Default 20. */
  libraryOcrMaxPages?: number;
  /** Wall-clock cap on one OCR'd page, in ms. Default 30s. */
  libraryOcrPageTimeoutMs?: number;
  /** Wall-clock cap on one document's whole OCR run, in ms. Default 300s. */
  libraryOcrDocumentTimeoutMs?: number;
  /**
   * Concurrent OCR jobs. Past this, new uploads are told the queue is full
   * rather than being accepted into a backlog that grows without bound.
   */
  libraryOcrConcurrency?: number;
  /** Queued-but-not-started OCR jobs before uploads are refused. Default 8. */
  libraryOcrMaxQueue?: number;
  /** Largest input handed to OCR, in bytes, from `LIBRARY_OCR_MAX_INPUT_MB`. */
  libraryOcrMaxInputBytes?: number;
  casaosApiUrl: string;
  casaosProtectedApps: string[];
  /** Opt out of the HTTPS/loopback transport policy (trusted LANs only). */
  casaosAllowInsecureHttp?: boolean;
  /**
   * Every CasaOS app that hosts OpenMuse or its network access, by the exact
   * name it is installed under. Complements the lexical `casaosProtectedApps`
   * list: that list only matches names it was told about, so an installation
   * named anything else needs to be declared here.
   */
  casaosSelfApps: string[];
  /**
   * M3: send raw CasaOS log text to the model provider. Defaults to false
   * because redaction is best-effort and cannot cover a bespoke log format.
   * When false, casaos_app_logs returns a shape summary instead of text.
   */
  casaosLogToModel: boolean;
}

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export const intelligenceKeyRequiredMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

export function assertApiDeploymentConfig(
  config: Config,
): asserts config is Config & { intelligenceApiKey: string } {
  required(
    "CPK_INTELLIGENCE_API_KEY",
    intelligenceKeyRequiredMessage,
    config.intelligenceApiKey ?? "",
  );
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;

/** A library document is capped at 50 MB and an owner's library at 1 GB. */
export const LIBRARY_DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const LIBRARY_DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * Read `LIBRARY_MAX_FILE_MB` / `LIBRARY_MAX_TOTAL_MB` as byte counts.
 *
 * A blank, unparseable, non-positive or non-finite value falls back to the
 * default rather than throwing: a typo in an optional quota must not stop the
 * server from starting. `Number("")` is 0 and `Number(" 12 ")` is 12, so the
 * blank case has to be excluded before the range test.
 *
 * The total is floored to at least the per-file limit. Otherwise an operator who
 * sets a 500 MB total and leaves the 50 MB file default has configured a quota
 * no single upload can ever satisfy past the first one, which reads as a broken
 * library rather than as the setting that produced it.
 */
export function libraryLimits(env: Record<string, string | undefined> = process.env): {
  maxFileBytes: number;
  maxTotalBytes: number;
} {
  const megabytes = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value * 1024 * 1024) : fallback;
  };
  const maxFileBytes = megabytes("LIBRARY_MAX_FILE_MB", LIBRARY_DEFAULT_MAX_FILE_BYTES);
  return {
    maxFileBytes,
    maxTotalBytes: Math.max(
      megabytes("LIBRARY_MAX_TOTAL_MB", LIBRARY_DEFAULT_MAX_TOTAL_BYTES),
      maxFileBytes,
    ),
  };
}

/**
 * Read the OCR knobs, with documented defaults.
 *
 * These are the values that bound the work a single hostile or merely enormous
 * document can cause, so each one is validated rather than trusted:
 *
 * - `LIBRARY_OCR_MAX_PAGES` is clamped to at least 1. A 0 would silently disable
 *   OCR while leaving the feature looking configured.
 * - `LIBRARY_OCR_PAGE_TIMEOUT_MS` is floored at 1s, because a sub-second cap
 *   fails every legitimate page and reports a working engine as broken.
 * - `LIBRARY_OCR_CONCURRENCY` is capped at 4. Each job is a Tesseract process
 *   holding a page raster in memory, so unbounded concurrency on a small box is a
 *   way to run it out of RAM.
 *
 * As with the size limits, a blank or unparseable value falls back to the
 * default rather than failing startup.
 */
export function ocrLimits(env: Record<string, string | undefined> = process.env): {
  languages: string;
  maxPages: number;
  pageTimeoutMs: number;
  documentTimeoutMs: number;
  concurrency: number;
  maxQueue: number;
  maxInputBytes: number;
} {
  const integer = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  const megabytes = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value * 1024 * 1024) : fallback;
  };
  return {
    languages: env.LIBRARY_OCR_LANGS?.trim() || "eng+tur",
    maxPages: integer("LIBRARY_OCR_MAX_PAGES", 20),
    pageTimeoutMs: Math.max(1000, integer("LIBRARY_OCR_PAGE_TIMEOUT_MS", 30_000)),
    documentTimeoutMs: Math.max(5000, integer("LIBRARY_OCR_DOCUMENT_TIMEOUT_MS", 300_000)),
    concurrency: Math.min(4, integer("LIBRARY_OCR_CONCURRENCY", 2)),
    maxQueue: Math.min(50, integer("LIBRARY_OCR_MAX_QUEUE", 8)),
    // An OCR input is rendered to a raster before it is recognised, so the input
    // cap is well below the library's own 50 MB per-file cap: a 50 MB TIFF is
    // only a few hundred KB as PNG, but as raw pixels it is gigabytes.
    maxInputBytes: megabytes("LIBRARY_OCR_MAX_INPUT_MB", 25),
  };
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage),
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
    ...(() => {
      const limits = libraryLimits();
      return {
        libraryMaxFileBytes: limits.maxFileBytes,
        libraryMaxTotalBytes: limits.maxTotalBytes,
        ...ocrLimits(),
      };
    })(),
    // M1: no default address. A hardcoded fallback committed one operator's LAN
    // topology to the repository and, with CASAOS_ALLOW_INSECURE_HTTP=true,
    // sent the CasaOS password to whatever device later held that
    // DHCP-assigned IP. An unset URL now fails closed in
    // assertCasaOSUrlAllowed with a message naming the variable.
    casaosApiUrl: (process.env.CASAOS_API_URL ?? "").replace(/\/+$/, ""),
    casaosAllowInsecureHttp: process.env.CASAOS_ALLOW_INSECURE_HTTP === "true",
    casaosProtectedApps: (process.env.CASAOS_PROTECTED_APPS ?? "openmuse,tailscale,casaos")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    casaosSelfApps: (process.env.CASAOS_SELF_APPS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    casaosLogToModel: process.env.CASAOS_LOG_TO_MODEL === "true",
  };
  if (config.encryptionKey) {
    // Fail fast on a malformed key: encryptSecret/decryptSecret would throw
    // the same error at first use, but a bad key here means credentials can
    // never be saved or read, so surface it at startup/config time.
    assertValidEncryptionKey(config.encryptionKey);
  }
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  warnAboutCasaOSProtection(config);
  return config;
}

/** The built-in protected list, before any operator override. */
const DEFAULT_PROTECTED_APPS = "openmuse,tailscale,casaos";

/**
 * M2: the protected-app guard is lexical, so it only protects the names it was
 * told about. An operator who installs OpenMuse on CasaOS under any other name
 * leaves the app hosting the agent unguarded: the agent can then be told to
 * stop the machine it runs on. The guard cannot be made exhaustive by guessing
 * names, so this warns at startup instead, naming the variable that closes the
 * gap. Warnings only — a deployment that is correctly named must still start.
 */
export function warnAboutCasaOSProtection(config: Config): string[] {
  const warnings: string[] = [];
  if (!config.casaosApiUrl) return warnings;
  if (!process.env.CASAOS_PROTECTED_APPS && !config.casaosSelfApps.length)
    warnings.push(
      `[OpenMuse] CasaOS is configured but neither CASAOS_PROTECTED_APPS nor CASAOS_SELF_APPS is set, so only the built-in list (${DEFAULT_PROTECTED_APPS}) and the "openmuse-" prefix are protected. ` +
        "If OpenMuse runs on CasaOS under a different app name, add it to CASAOS_SELF_APPS, or the agent could be asked to stop the app hosting it.",
    );
  else if (!config.casaosSelfApps.length)
    warnings.push(
      "[OpenMuse] CASAOS_SELF_APPS is empty. Set it to every CasaOS app that hosts OpenMuse or its network access, so they are protected by identity and not only by name pattern.",
    );
  for (const warning of warnings) console.warn(warning);
  return warnings;
}
