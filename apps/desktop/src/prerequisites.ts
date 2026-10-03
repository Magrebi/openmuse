import { DesktopError } from "./errors.js";

export type CheckId =
  | "docker-cli"
  | "docker-daemon"
  | "compose-plugin"
  | "env-file"
  | "api-port"
  | "web-port"
  | "worker-port";

export type CheckStatus = "ok" | "failed" | "skipped";

export interface CheckResult {
  readonly id: CheckId;
  readonly label: string;
  readonly status: CheckStatus;
  /** One line the person can act on. Never a stack trace. */
  readonly fix?: string;
}

export interface PrerequisiteProbes {
  /** Docker CLI present. */
  dockerCli(): Promise<boolean>;
  /** Daemon reachable. */
  dockerDaemon(): Promise<boolean>;
  /** `docker compose` subcommand available. */
  composePlugin(): Promise<boolean>;
  envFile(): Promise<boolean>;
  /** Whether a TCP port is already bound on loopback. */
  portInUse(port: number): Promise<boolean>;
}

export const apiPort = 8787;
export const webPort = 8081;
export const workerPort = 8790;

const portFix = (port: number, inUse: boolean) =>
  inUse
    ? `Port ${port} is already in use. Stop the other program, or stop that OpenMuse.`
    : undefined;

/**
 * Check everything needed to start, in the order a person would fix it. A
 * failure is reported as a single actionable line, never a stack trace.
 */
export async function checkPrerequisites(probes: PrerequisiteProbes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (result: CheckResult) => results.push(result);

  let cli = false;
  try {
    cli = await probes.dockerCli();
    add(
      cli
        ? { id: "docker-cli", label: "Docker", status: "ok" }
        : {
            id: "docker-cli",
            label: "Docker",
            status: "failed",
            fix: "Install Docker Desktop, then reopen the OpenMuse app.",
          },
    );
  } catch {
    add({
      id: "docker-cli",
      label: "Docker",
      status: "failed",
      fix: "Install Docker Desktop, then reopen the OpenMuse app.",
    });
  }

  // The daemon only matters once the CLI exists.
  if (cli) {
    const daemon = await probes.dockerDaemon().catch(() => false);
    add(
      daemon
        ? { id: "docker-daemon", label: "Docker is running", status: "ok" }
        : {
            id: "docker-daemon",
            label: "Docker is running",
            status: "failed",
            fix: "Start Docker Desktop and try again.",
          },
    );
    const compose = await probes.composePlugin().catch(() => false);
    add(
      compose
        ? { id: "compose-plugin", label: "Docker Compose", status: "ok" }
        : {
            id: "compose-plugin",
            label: "Docker Compose",
            status: "failed",
            fix: "Update Docker Desktop to include Docker Compose.",
          },
    );
  } else {
    for (const id of ["docker-daemon", "compose-plugin"] as const)
      add({ id, label: id, status: "skipped" });
  }

  const env = await probes.envFile().catch(() => false);
  add(
    env
      ? { id: "env-file", label: "Configuration file", status: "ok" }
      : {
          id: "env-file",
          label: "Configuration file",
          status: "failed",
          fix: "Run the Setup wizard to create the .env file.",
        },
  );

  for (const [id, label, port] of [
    ["api-port", "API port", apiPort],
    ["web-port", "Web port", webPort],
    ["worker-port", "Browser worker port", workerPort],
  ] as const) {
    const inUse = await probes.portInUse(port).catch(() => false);
    add(
      inUse
        ? { id, label: `${label} ${port}`, status: "failed", fix: portFix(port, true) }
        : { id, label: `${label} ${port}`, status: "ok" },
    );
  }

  return results;
}

export const blockingFailures = (results: CheckResult[]): CheckResult[] =>
  results.filter((result) => result.status === "failed");

/** The single most useful line to show above the status page. */
export function prerequisiteSummary(results: CheckResult[]): string | undefined {
  const failed = blockingFailures(results);
  if (!failed.length) return undefined;
  const withFix = failed.find((result) => result.fix);
  if (withFix) return withFix.fix;
  throw new DesktopError("PREREQUISITE_MISSING", "A prerequisite check failed");
}
