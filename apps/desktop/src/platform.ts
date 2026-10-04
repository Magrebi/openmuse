import type { CommandSpec } from "./deployment.js";
import type { FileIo } from "./envfile.js";

/**
 * Every side effect the TypeScript core needs, declared here. The Rust layer
 * implements these; tests implement them with fakes. Keeping them behind an
 * interface is what lets the same modules run in the webview and under Node.
 */
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessHandle {
  /** Ask the process to stop. Never a kill by name or by pattern. */
  stop(): Promise<void>;
  /** Resolves when the process exits, including after `stop`. */
  readonly exited: Promise<ProcessResult>;
}

export interface LogSink {
  /** Untrusted text for display. Never executed, never interpreted. */
  write(text: string): void;
}

export interface PlatformPorts extends FileIo {
  /**
   * Run a command. `spec.program` is `docker` or `pnpm` only, and the Rust side
   * hardcodes the program it will execute, so no caller can reach a shell.
   */
  run(spec: CommandSpec, options?: { timeoutMs?: number }): Promise<ProcessResult>;
  /** Start a long-lived process such as `docker compose logs -f`. */
  spawn(spec: CommandSpec, sink: LogSink): ProcessHandle;
  /** Read a value from the OS keychain. Secrets are not stored in app settings. */
  keychainGet(key: string): Promise<string | null>;
  keychainSet(key: string, value: string): Promise<void>;
  /**
   * Reflect the state machine in the system tray.
   *
   * `spark` is a short list of already-scaled bar heights, oldest first. It is a
   * list rather than a picture so the platform layer stays a transport and every
   * decision about what the bars mean stays in tested TypeScript. Optional, so a
   * host implementation predating it still satisfies the port.
   */
  traySet(tone: string, tooltip: string, spark?: readonly number[]): Promise<void>;
  /** Raise an OS notification. */
  notify(title: string, body: string): Promise<void>;
  /** Point the app window at a URL. */
  openWebview(url: string): Promise<void>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
