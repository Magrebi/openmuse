/**
 * Desktop failures carry a stable code and, where a person can act, one line of
 * advice. Stack traces, raw compose output and secrets stay out of the UI: the
 * control surface shows `fix`, and everything else goes to the log viewer as
 * untrusted text.
 */
export const desktopErrorCodes = [
  "PREREQUISITE_MISSING",
  "PATH_OUTSIDE_REPO",
  "COMPOSE_FAILED",
  "COMPOSE_TIMEOUT",
  "ENV_INVALID",
  "ENV_BACKUP_FAILED",
  "HEALTH_UNREACHABLE",
  "HEALTH_INVALID",
  "UNSUPPORTED",
] as const;

export type DesktopErrorCode = (typeof desktopErrorCodes)[number];

export class DesktopError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
    /** One line the person can act on. Never a stack trace. */
    readonly fix?: string,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

export function desktopError(code: DesktopErrorCode, message: string, fix?: string): DesktopError {
  return new DesktopError(code, message, fix);
}

/** The single line shown next to a failed check. Never a stack trace. */
export function oneLineFix(error: unknown): string | undefined {
  return error instanceof DesktopError ? error.fix : undefined;
}

/** Stable, non-secret code for logs. Unknown throwables never leak a message. */
export function errorCode(error: unknown): string {
  if (error instanceof DesktopError) return error.code;
  if (error instanceof Error && error.name) return error.name.replace(/[^A-Za-z0-9_.-]/g, "");
  return "DesktopFailure";
}
