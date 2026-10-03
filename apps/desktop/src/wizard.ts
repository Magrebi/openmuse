import { type EnvPlan, type EnvValues, parseEnvFile, planEnvUpdate } from "./envfile.js";
import { DesktopError } from "./errors.js";
import { type GeneratedSecrets, generateSecrets, type RandomBytes } from "./secrets.js";

/**
 * The wizard is re-runnable. It repairs a `.env` that is missing or invalid and
 * leaves everything it does not need to change untouched, so running it twice
 * never rotates a working secret behind the owner's back.
 */

export const wizardSteps = ["prerequisites", "secrets", "model", "verify"] as const;

export type WizardStep = (typeof wizardSteps)[number];

export const providers = ["openai", "anthropic", "google"] as const;

export type Provider = (typeof providers)[number];

/** The `.env` key each provider's key is written to, matching apps/server. */
export const providerKeyName: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * The server's own minimums, restated here so the wizard can explain a bad
 * `.env` without starting it. See the live-mode check in apps/server/src/config.ts.
 */
export const accessKeyMinimum = 24;
export const workerTokenMinimum = 32;

const isUsableAccessKey = (value: string) => value.length >= accessKeyMinimum;
const isUsableWorkerToken = (value: string) => value.length >= workerTokenMinimum;
/** 32 bytes encoded as base64 is 44 characters ending in a single `=`. */
const isUsableEncryptionKey = (value: string) => /^[A-Za-z0-9+/]{43}=$/.test(value);

export type SecretProblem = "missing" | "too-short" | "malformed" | "present";

export interface SecretStatus {
  readonly key: keyof GeneratedSecrets;
  readonly status: SecretProblem;
  /** One line the person can act on, present only when the value is unusable. */
  readonly fix?: string;
}

/** Inspect the secrets already in `.env` without changing anything. */
export function secretStatuses(values: EnvValues): SecretStatus[] {
  const problems: [keyof GeneratedSecrets, (value: string) => boolean, string][] = [
    [
      "OPENMUSE_ACCESS_KEY",
      isUsableAccessKey,
      `Set OPENMUSE_ACCESS_KEY to at least ${accessKeyMinimum} characters.`,
    ],
    [
      "TOKEN_ENCRYPTION_KEY",
      isUsableEncryptionKey,
      "Set TOKEN_ENCRYPTION_KEY to 32 random bytes encoded as base64.",
    ],
    [
      "WORKER_TOKEN",
      isUsableWorkerToken,
      `Set WORKER_TOKEN to at least ${workerTokenMinimum} characters.`,
    ],
  ];
  return problems.map(([key, usable, fix]) => {
    const value = values[key];
    if (!value) return { key, status: "missing", fix };
    if (usable(value)) return { key, status: "present" };
    const malformed = key === "TOKEN_ENCRYPTION_KEY";
    return { key, status: malformed ? "malformed" : "too-short", fix };
  });
}

export interface SecretsStep {
  /** Keys whose value must be written. Absent values are generated. */
  readonly updates: EnvValues;
  /** Only the values newly generated here, so the UI can show the key once. */
  readonly generated: GeneratedSecrets | null;
  /** Secrets already in `.env` that this run preserved untouched. */
  readonly preserved: (keyof GeneratedSecrets)[];
  /** A present secret was replaced, so the caller must confirm and back up. */
  readonly replaces: (keyof GeneratedSecrets)[];
}

/**
 * Decide which secrets to generate. A usable existing value is preserved unless
 * the person explicitly asks to regenerate that one key, so re-running the
 * wizard repairs a broken `.env` instead of invalidating a working deployment.
 */
export function secretsStep(
  current: string,
  randomBytes: RandomBytes,
  regenerate: readonly (keyof GeneratedSecrets)[] = [],
): SecretsStep {
  const values = parseEnvFile(current);
  const status = secretStatuses(values);
  const wanted = new Set(regenerate);
  const missing = status.filter((entry) => wanted.has(entry.key) || entry.status !== "present");
  const generated = missing.length ? generateSecrets(randomBytes) : null;
  const updates: EnvValues = {};
  for (const entry of missing) updates[entry.key] = generated?.[entry.key] as string;
  return {
    updates,
    generated,
    preserved: status.filter((entry) => !missing.includes(entry)).map((entry) => entry.key),
    replaces: missing
      .filter((entry) => wanted.has(entry.key) && Boolean(values[entry.key]))
      .map((entry) => entry.key),
  };
}

export interface ModelChoice {
  readonly provider: Provider;
  /** Model id, or a full `provider/model` string the provider must match. */
  readonly model: string;
  readonly apiKey: string;
}

export interface ModelStep {
  readonly model: string;
  readonly apiKey: string;
  readonly updates: EnvValues;
}

/**
 * A `provider/model` string, matching the resolver in
 * apps/server/src/engine/tanstack-agent.ts. A gateway id such as
 * `openai/vendor/model` keeps its inner slashes.
 */
export const modelSpecSchema = (value: string): string => {
  const spec = value.trim();
  if (!/^[^/:]+\/.+$/.test(spec))
    throw new DesktopError(
      "ENV_INVALID",
      `Not a model: ${spec}`,
      'Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".',
    );
  return spec;
};

/**
 * Turn a provider choice into `.env` updates: `MODEL` plus that provider's key.
 * A provider key that is already set is preserved unless it was pasted again,
 * so the wizard never silently replaces a working credential with a typo.
 */
export function modelStep(current: string, choice: ModelChoice): ModelStep {
  const values = parseEnvFile(current);
  const keyName = providerKeyName[choice.provider];
  const apiKey = choice.apiKey.trim();
  if (!apiKey)
    throw new DesktopError(
      "ENV_INVALID",
      "Paste your provider key",
      `It is written to ${keyName}.`,
    );
  const full = choice.model.includes("/")
    ? choice.model.trim()
    : `${choice.provider}/${choice.model}`;
  const spec = modelSpecSchema(full);
  if (spec.slice(0, spec.indexOf("/")) !== choice.provider)
    throw new DesktopError(
      "ENV_INVALID",
      `${spec} does not match the ${choice.provider} provider`,
      `Enter a ${choice.provider} model id, or pick that provider instead.`,
    );
  const updates: EnvValues = { MODEL: spec };
  if (values[keyName] !== apiKey) updates[keyName] = apiKey;
  return { model: spec, apiKey, updates };
}

/**
 * `CPK_INTELLIGENCE_API_KEY` is required in every mode and `npx copilotkit@latest
 * login` prints it. The wizard takes the pasted value rather than shelling out,
 * so the key reaches `.env` and never an argv.
 */
export function intelligenceStep(current: string, key: string): EnvValues {
  const value = key.trim();
  if (!value)
    throw new DesktopError(
      "ENV_INVALID",
      "Paste your CopilotKit Intelligence key",
      "Run `npx copilotkit@latest login` and paste the generated key.",
    );
  return parseEnvFile(current).CPK_INTELLIGENCE_API_KEY === value
    ? {}
    : { CPK_INTELLIGENCE_API_KEY: value };
}

/** Merge the steps into one plan, so the UI shows a single reviewable diff. */
export function wizardPlan(current: string, updates: EnvValues): EnvPlan {
  return planEnvUpdate(current, updates);
}
