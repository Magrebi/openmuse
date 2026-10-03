import { DesktopError } from "./errors.js";
import { assertWritable } from "./paths.js";
import { secretKeys } from "./secrets.js";

export type EnvValues = Record<string, string>;

export interface EnvComment {
  readonly key: string;
  readonly comment?: string;
}

/**
 * Parse `.env` while keeping the file's shape: comments, blank lines and order
 * are preserved so an edit produces a reviewable diff rather than a rewrite.
 */
export function parseEnvFile(text: string): EnvValues {
  const values: EnvValues = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    )
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/** Every key mentioned in `.env.example`, including commented-out ones. */
export function exampleKeys(text: string): EnvComment[] {
  const keys: EnvComment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key) continue;
    if (!keys.some((entry) => entry.key === key))
      keys.push({ key, comment: line.startsWith("#") ? line.slice(1).trim() : undefined });
  }
  return keys;
}

const isSecret = (key: string) => (secretKeys as readonly string[]).includes(key);

/**
 * Render the proposed `.env`. Existing text is reused verbatim except for the
 * keys being changed, and a missing key is appended rather than inserted, so a
 * person can read exactly what changed.
 */
export function applyEnvValues(current: string, updates: EnvValues): string {
  const lines = current.length ? current.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const written = new Set<string>();
  const quote = (key: string, value: string) =>
    isSecret(key) || /[\s"'#=]/.test(value) ? `'${value.replace(/'/g, "\\'")}'` : value;

  const next = lines.map((line) => {
    const match = /^(\s*)(#?\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/.exec(line);
    const key = match?.[3];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    written.add(key);
    // A commented-out example becomes a real assignment once it is set, and the
    // example's trailing explanation is dropped because the value now speaks for
    // itself.
    return `${match?.[1] ?? ""}${key}=${quote(key, value)}`;
  });

  const appended = [...pending.entries()].map(([key, value]) => `${key}=${quote(key, value)}`);
  const body = [...next, ...appended].join("\n").replace(/\n{3,}/g, "\n\n");
  return body.endsWith("\n") || body.length ? `${body.replace(/\n*$/, "")}\n` : body;
}

export interface EnvPlan {
  readonly before: string;
  readonly after: string;
  readonly changes: { key: string; before?: string; after?: string }[];
  /** True when the write replaces an existing value, so a backup is required. */
  readonly overwrites: boolean;
}

/**
 * Build the change for the wizard without writing. Values that are unchanged,
 * including secrets, never appear in the plan shown on screen.
 */
export function planEnvUpdate(current: string, updates: EnvValues): EnvPlan {
  const existing = parseEnvFile(current);
  const changes = Object.entries(updates)
    .filter(([key, value]) => existing[key] !== value)
    .map(([key, value]) => ({ key, before: existing[key], after: value }));
  return {
    before: current,
    after: applyEnvValues(current, updates),
    changes,
    overwrites: changes.some((change) => change.before !== undefined),
  };
}

export interface FileIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  copyFile(from: string, to: string): Promise<void>;
}

const backupSuffix = (stamp: string) => `.bak-${stamp}`;

/**
 * Write `.env` in place. An existing file is always copied to a timestamped
 * backup first, so a bad generation is recoverable without a terminal.
 */
export async function writeEnvWithBackup(
  root: string,
  updates: EnvValues,
  io: FileIo,
  stamp: string,
): Promise<{ path: string; backup?: string }> {
  const path = assertWritable(root, ".env");
  const before = (await io.exists(path)) ? await io.readFile(path) : "";
  const after = applyEnvValues(before, updates);
  let backup: string | undefined;
  if (before) {
    backup = `${path}${backupSuffix(stamp)}`;
    try {
      await io.copyFile(path, backup);
    } catch {
      throw new DesktopError(
        "ENV_BACKUP_FAILED",
        "Could not back up .env before writing",
        "Close any editor holding the file, then try again.",
      );
    }
  }
  await io.writeFile(path, after);
  return { path, backup };
}

/** A one-line summary of a plan, with every secret value hidden. */
export function summarizePlan(plan: EnvPlan): string {
  if (!plan.changes.length) return "No changes.";
  return plan.changes
    .map((change) =>
      isSecret(change.key)
        ? `${change.key} = ${change.before === undefined ? "(set)" : "(changed)"}`
        : `${change.key} = ${change.after}`,
    )
    .join("; ");
}
