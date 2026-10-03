import { DesktopError } from "./errors.js";

export type DeploymentMode = "host" | "container";

export type ServiceName = "api" | "web" | "browser-worker";

export const serviceNames: readonly ServiceName[] = ["api", "web", "browser-worker"];

export interface RepoPaths {
  /** Absolute, normalized repository root. */
  readonly root: string;
  /** Compose file, relative to the repo. */
  readonly composeFile: string;
  /** Env file, relative to the repo. */
  readonly envFile: string;
}

export interface CommandSpec {
  readonly program: string;
  /** Argument array. Never a shell string, so nothing here is re-parsed. */
  readonly args: string[];
  readonly cwd: string;
}

/**
 * `down` deliberately omits `-v`. Volumes are the browser profiles and saved
 * downloads; deleting them is not reachable from this surface.
 */
export function composeUp(paths: RepoPaths): string[] {
  return ["compose", "-f", paths.composeFile, "--env-file", paths.envFile, "up", "--build", "-d"];
}

export function composeDown(paths: RepoPaths): string[] {
  return ["compose", "-f", paths.composeFile, "--env-file", paths.envFile, "down"];
}

export function composeLogs(
  paths: RepoPaths,
  service: ServiceName,
  options: { follow?: boolean; tail?: number } = {},
): string[] {
  const args = ["compose", "-f", paths.composeFile, "--env-file", paths.envFile, "logs"];
  if (options.follow !== false) args.push("-f");
  args.push(`--tail=${options.tail ?? 200}`);
  args.push(service);
  return args;
}

/** Every command above this program. The Rust layer hardcodes `docker` too. */
export const dockerProgram = "docker";
export const pnpmProgram = "pnpm";

/**
 * In host mode the API and web UI run as repo-local processes, matching the
 * documented `pnpm dev` + `pnpm dev:web` flow, and only the browser worker runs
 * in Compose. Container mode runs the whole stack through Compose.
 */
export function serviceStart(
  mode: DeploymentMode,
  service: ServiceName,
  paths: RepoPaths,
): CommandSpec {
  if (mode === "container" || service === "browser-worker")
    return { program: dockerProgram, args: composeUp(paths), cwd: paths.root };
  const args = service === "api" ? ["dev"] : ["--dir", "apps/mobile", "web"];
  return { program: pnpmProgram, args, cwd: paths.root };
}

/**
 * A stop command, or `null` when the service is a host process. The controller
 * owns those lifetimes and signals them directly, so there is nothing to spawn.
 */
export function serviceStop(
  mode: DeploymentMode,
  service: ServiceName,
  paths: RepoPaths,
): CommandSpec | null {
  if (mode === "container" || service === "browser-worker")
    return { program: dockerProgram, args: composeDown(paths), cwd: paths.root };
  return null;
}

/** Services this mode owns as OS processes and can therefore start and stop. */
export function hostServices(mode: DeploymentMode): ServiceName[] {
  return mode === "container" ? [] : ["api", "web"];
}

export function logsCommand(
  mode: DeploymentMode,
  service: ServiceName,
  paths: RepoPaths,
): CommandSpec {
  if (mode === "container" || service === "browser-worker")
    return {
      program: dockerProgram,
      args: composeLogs(paths, service, { follow: true, tail: 200 }),
      cwd: paths.root,
    };
  // Host processes write to the controller's captured output, so a logs command
  // is only meaningful for the containerized worker.
  throw new DesktopError(
    "UNSUPPORTED",
    `${service} runs as a local process; its output is already captured.`,
    "Switch to the Logs tab to read it.",
  );
}

/** Container mode is the only mode that can run the API in Compose. */
export function requiresLiveMode(mode: DeploymentMode): boolean {
  return mode === "container";
}
