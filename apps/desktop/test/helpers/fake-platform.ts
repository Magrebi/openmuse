import type { RepoPaths } from "../../src/deployment.js";
import type { PlatformPorts, ProcessHandle, ProcessResult } from "../../src/platform.js";

export const paths: RepoPaths = {
  root: "/repo",
  composeFile: "infra/compose.yaml",
  envFile: ".env",
};

export const healthyBody = {
  ok: true,
  mode: "sample",
  agentConfigured: true,
  browserConfigured: true,
};

export const healthy = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ...healthyBody, ...over }));

export const refused = () => {
  throw new Error("ECONNREFUSED");
};

export interface Recorded {
  readonly commands: { program: string; args: string[]; cwd: string }[];
  /** Every tray paint, in order. `spark` is absent before any activity. */
  readonly tray: { tone: string; tooltip: string; spark?: number[] }[];
  readonly notifications: string[];
  readonly webviews: string[];
  readonly files: Record<string, string>;
  /** Text written by a spawned process, for the log-redaction test. */
  readonly spawned: { args: string[]; sink: { write(text: string): void } }[];
}

export interface FakePlatform {
  readonly ports: PlatformPorts;
  readonly recorded: Recorded;
  setHealth(next: () => Response): void;
  fetchImpl: typeof fetch;
}

const exited: ProcessResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/**
 * A platform that records every effect. Tests assert on the argv, cwd and calls
 * that reached the boundary, which is what proves the shell surface is closed.
 */
export function fakePlatform(
  options: {
    health?: () => Response;
    runResult?: (program: string, args: string[]) => ProcessResult;
  } = {},
): FakePlatform {
  const recorded: Recorded = {
    commands: [],
    tray: [],
    notifications: [],
    webviews: [],
    files: {},
    spawned: [],
  };
  let health = options.health ?? (() => healthy());
  const ports: PlatformPorts = {
    run: async (spec) => {
      recorded.commands.push({ program: spec.program, args: [...spec.args], cwd: spec.cwd });
      return options.runResult?.(spec.program, spec.args) ?? exited;
    },
    spawn: (spec, sink): ProcessHandle => {
      recorded.commands.push({ program: spec.program, args: [...spec.args], cwd: spec.cwd });
      recorded.spawned.push({ args: [...spec.args], sink });
      return { stop: async () => undefined, exited: Promise.resolve(exited) };
    },
    readFile: async (path) => recorded.files[path] ?? "",
    writeFile: async (path, contents) => {
      recorded.files[path] = contents;
    },
    exists: async (path) => path in recorded.files,
    copyFile: async (from, to) => {
      recorded.files[to] = recorded.files[from] ?? "";
    },
    keychainGet: async () => null,
    keychainSet: async () => undefined,
    traySet: async (tone, tooltip, spark) => {
      recorded.tray.push({ tone, tooltip, spark: spark ? [...spark] : undefined });
    },
    notify: async (_title, body) => {
      recorded.notifications.push(body);
    },
    openWebview: async (url) => {
      recorded.webviews.push(url);
    },
  };
  return {
    ports,
    recorded,
    setHealth: (next) => {
      health = next;
    },
    fetchImpl: async () => health(),
  };
}

/** A compose step that fails with the given stderr. */
export const composeFailure = (stderr: string) => (_program: string, args: string[]) =>
  args.includes("compose") ? { exitCode: 1, stdout: "", stderr, timedOut: false } : exited;
