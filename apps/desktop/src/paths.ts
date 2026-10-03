import { DesktopError } from "./errors.js";

/**
 * Files the desktop app may read or write. Canonical state lives in these; the
 * app never invents a store of its own.
 */
export const writableRepoFiles = [".env", ".env.example", "infra/compose.yaml"] as const;

export type WritableRepoFile = (typeof writableRepoFiles)[number];

/** Normalize separators, drop `.`, and collapse `..` without touching the disk. */
export function normalizePath(input: string): string {
  const unified = input.replace(/\\/g, "/");
  const prefix = /^[A-Za-z]:\//.test(unified)
    ? unified.slice(0, 3)
    : unified.startsWith("/")
      ? "/"
      : "";
  const segments: string[] = [];
  for (const segment of unified.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    // A leading `..` in a relative path cannot be resolved, so it is preserved
    // and rejected later by resolveInRepo rather than silently dropped.
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (last && last !== "..") segments.pop();
      else segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return prefix.endsWith("/")
    ? `${prefix}${joined}`
    : joined
      ? `${prefix}${joined}`
      : prefix || ".";
}

function isInside(repoRoot: string, target: string): boolean {
  if (target === repoRoot) return true;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return target.startsWith(prefix);
}

/**
 * Resolve a path and refuse anything outside the repository. A `../` escape, an
 * absolute path elsewhere, or a symlink-style trick is rejected before any
 * subprocess or file write happens.
 */
export function resolveInRepo(repoRoot: string, candidate: string): string {
  const root = normalizePath(repoRoot);
  const target = normalizePath(
    candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)
      ? candidate
      : `${root}/${candidate}`,
  );
  if (!isInside(root, target))
    throw new DesktopError(
      "PATH_OUTSIDE_REPO",
      `Path is outside the OpenMuse repository: ${candidate}`,
      "Choose a file inside the OpenMuse folder.",
    );
  return target;
}

/** Repo-relative form used for display and for the allowlist check. */
export function repoRelative(repoRoot: string, absolute: string): string {
  const root = normalizePath(repoRoot);
  const target = normalizePath(absolute);
  if (target === root) return ".";
  return isInside(root, target)
    ? target.slice(root.endsWith("/") ? root.length : root.length + 1)
    : target;
}

/** Only the canonical state files may be written through the desktop app. */
export function assertWritable(repoRoot: string, candidate: string): string {
  const absolute = resolveInRepo(repoRoot, candidate);
  const relative = repoRelative(repoRoot, absolute);
  if (!(writableRepoFiles as readonly string[]).includes(relative))
    throw new DesktopError(
      "PATH_OUTSIDE_REPO",
      `The desktop app does not edit ${relative}`,
      `Editable files: ${writableRepoFiles.join(", ")}.`,
    );
  return absolute;
}
