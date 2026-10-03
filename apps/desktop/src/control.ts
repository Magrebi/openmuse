import {
  composeDown,
  type DeploymentMode,
  hostServices,
  logsCommand,
  type RepoPaths,
  type ServiceName,
  serviceNames,
  serviceStart,
  serviceStop,
} from "./deployment.js";
import { errorCode } from "./errors.js";
import { assertLoopback, readHealth } from "./health.js";
import type { Clock, PlatformPorts, ProcessHandle } from "./platform.js";
import { redact } from "./secrets.js";
import {
  type Deployment,
  type DeploymentEvent,
  initialDeployment,
  toneFor,
  transition,
} from "./state.js";

export const healthIntervalMs = 5000;
export const startTimeoutMs = 90_000;
export const webUrl = "http://127.0.0.1:8081";
export const healthUrl = "http://127.0.0.1:8787/api/health";

export interface ControllerOptions {
  readonly ports: PlatformPorts;
  readonly paths: RepoPaths;
  readonly mode: DeploymentMode;
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly healthIntervalMs?: number;
  readonly startTimeoutMs?: number;
}

export type Listener = (deployment: Deployment) => void;

const fixedClock: Clock = { now: () => Date.now() };
/**
 * Owns the one deployment state machine and drives it from compose exit codes
 * and health polls. Surfaces subscribe; none of them keeps its own copy.
 */
export class DeploymentController {
  private deployment: Deployment = initialDeployment();
  private readonly listeners = new Set<Listener>();
  private readonly children = new Map<string, ProcessHandle>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private secrets: string[] = [];
  private lastAnnounced = "";
  /** Set by stopAll; blocks further scheduling so nothing keeps the loop alive. */
  private closed = false;

  /** Receives already-redacted log lines for the viewer. */
  sink: ((line: string) => void) | undefined;

  constructor(private readonly options: ControllerOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? fixedClock;
  }

  get state(): Deployment {
    return this.deployment;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.deployment);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private dispatch(event: DeploymentEvent): Deployment {
    const next = transition(this.deployment, event);
    if (next === this.deployment) return next;
    this.deployment = next;
    for (const listener of this.listeners) listener(next);
    void this.announce(next);
    return next;
  }

  /** Remember values that must be stripped from any captured output. */
  setSecrets(values: string[]): void {
    this.secrets = values.filter((value) => Boolean(value));
  }

  /** Mirror the machine into the tray, and notify on healthy, degraded and error. */
  private async announce(deployment: Deployment): Promise<void> {
    try {
      await this.options.ports.traySet(toneFor(deployment.state), `OpenMuse — ${deployment.state}`);
      const message =
        deployment.state === "healthy"
          ? "OpenMuse is running."
          : deployment.state === "error"
            ? (deployment.reason ?? "OpenMuse could not start.")
            : deployment.state === "degraded"
              ? (deployment.reason ?? "OpenMuse is running with a problem.")
              : undefined;
      // Once per distinct state, so a flapping poll cannot spam the desktop.
      if (message && this.lastAnnounced !== deployment.state) {
        this.lastAnnounced = deployment.state;
        await this.options.ports.notify("OpenMuse", message);
      }
    } catch {
      // A tray or notification failure must not change deployment state.
    }
  }

  /**
   * Schedule the next poll. A closed controller never reschedules, so stopping
   * releases the timer handle and nothing keeps the process alive.
   */
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    this.timer = setTimeout(() => void this.pollHealth(true), delay);
  }

  /**
   * One health poll. While `starting`, an unreachable API is expected and only
   * the start timeout decides; once running, a failure degrades rather than
   * errors, so a restarting worker does not read as a crash.
   *
   * `continuePolling` is false for a caller that drives one poll itself, so no
   * timer outlives the call.
   */
  async pollHealth(continuePolling = false): Promise<void> {
    const interval = this.options.healthIntervalMs ?? healthIntervalMs;
    const before = this.deployment.state;
    const reading = await readHealth(healthUrl, this.options.fetchImpl, 2000);

    if (reading.probe === "healthy") {
      this.dispatch({ type: "HEALTH_OK" });
      if (before === "starting" || before === "stopped") await this.openWebUi();
    } else if (reading.probe === "degraded") {
      // Carry the specific line from the health layer so the person is told what
      // to configure, not just that something is incomplete.
      this.dispatch({ type: "HEALTH_PARTIAL", reason: reading.fix });
    } else if (before === "starting") {
      if (this.clock.now() - this.startedAt > (this.options.startTimeoutMs ?? startTimeoutMs)) {
        this.dispatch({ type: "START_TIMEOUT" });
        return;
      }
      return this.reschedule(interval, continuePolling);
    } else if (before === "healthy") {
      this.dispatch({ type: "HEALTH_FAIL" });
    }

    if (["unknown", "stopped", "stopping", "error"].includes(this.deployment.state)) return;
    this.reschedule(interval, continuePolling);
  }

  private reschedule(interval: number, continuePolling: boolean): void {
    if (continuePolling) this.schedule(interval);
  }

  /** The launch probe: is this deployment already running? */
  async probe(): Promise<Deployment> {
    const reading = await readHealth(healthUrl, this.options.fetchImpl, 1500);
    return this.dispatch({
      type: "PROBE",
      result: reading.probe === "unreachable" ? "stopped" : reading.probe,
      reason: reading.fix,
    });
  }

  /**
   * Start every service. In host mode the API and web UI run as repo-local
   * processes; the browser worker always runs through Compose. Only a non-zero
   * exit or a timeout moves the machine out of `starting`.
   *
   * `autoPoll` starts the recurring health poll. Callers that drive their own
   * polls pass false so no timer outlives the call.
   */
  async up(autoPoll = true): Promise<Deployment> {
    const next = this.dispatch({ type: "UP_REQUESTED" });
    if (next.state !== "starting") return next;
    this.startedAt = this.clock.now();
    try {
      for (const service of serviceNames) {
        const spec = serviceStart(this.options.mode, service, this.options.paths);
        if (hostServices(this.options.mode).includes(service)) {
          this.children.set(
            service,
            this.options.ports.spawn(spec, { write: (text) => this.appendLog(service, text) }),
          );
          continue;
        }
        const result = await this.options.ports.run(spec, { timeoutMs: 600_000 });
        if (result.timedOut || result.exitCode !== 0) {
          this.dispatch({
            type: "COMPOSE_FAILED",
            code: result.timedOut ? "COMPOSE_TIMEOUT" : "COMPOSE_FAILED",
            reason: this.composeReason(service, result.stderr || result.stdout),
          });
          return this.deployment;
        }
      }
    } catch (error) {
      this.dispatch({
        type: "COMPOSE_FAILED",
        code: errorCode(error) === "COMPOSE_TIMEOUT" ? "COMPOSE_TIMEOUT" : "COMPOSE_FAILED",
        reason: redact(
          error instanceof Error ? error.message : "Compose could not be started",
          this.secrets,
        ),
      });
      return this.deployment;
    }
    if (autoPoll) this.schedule(this.options.healthIntervalMs ?? healthIntervalMs);
    return this.deployment;
  }

  /** Turn raw compose output into one actionable line instead of a stack trace. */
  private composeReason(service: ServiceName, output: string): string {
    const text = redact(output, this.secrets).toLowerCase();
    if (text.includes("work on your machine") || text.includes("cannot connect to the docker"))
      return "Docker is not running. Start Docker Desktop, then try again.";
    if (text.includes("worker_token"))
      return "WORKER_TOKEN is not set. Run the Setup wizard to create the .env file.";
    if (text.includes("port is already allocated") || text.includes("address already in use"))
      return `A port ${service} needs is already in use. Stop the other program and try again.`;
    return `Could not start ${service}. Open the Logs tab for details.`;
  }

  /**
   * Stop every service. `docker compose down` never passes `-v`, so volumes and
   * saved browser profiles survive a stop and a restart.
   */
  async down(): Promise<Deployment> {
    const next = this.dispatch({ type: "DOWN_REQUESTED" });
    if (next.state !== "stopping") return next;
    if (this.timer) clearTimeout(this.timer);
    let failed = false;
    for (const [name, child] of this.children) {
      try {
        await child.stop();
        const result = await child.exited;
        if (result.exitCode !== 0 && result.exitCode !== null) failed = true;
      } catch {
        failed = true;
      }
      this.children.delete(name);
    }
    const spec = serviceStop(this.options.mode, "browser-worker", this.options.paths);
    if (spec) {
      try {
        const result = await this.options.ports.run(spec, { timeoutMs: 120_000 });
        if (result.exitCode !== 0) failed = true;
      } catch {
        failed = true;
      }
    }
    return this.dispatch(
      failed
        ? { type: "DOWN_EXIT_FAIL", reason: "Some services did not stop." }
        : { type: "DOWN_EXIT_OK" },
    );
  }

  /** Stream one service's logs. Output is untrusted text, displayed only. */
  async watchLogs(service: ServiceName): Promise<void> {
    const spec = logsCommand(this.options.mode, service, this.options.paths);
    this.children.set(
      `logs:${service}`,
      this.options.ports.spawn(spec, { write: (text) => this.appendLog(service, text) }),
    );
  }

  /**
   * Append service output to the log viewer. The text is untrusted: it is
   * redacted and split into lines, never executed or interpreted.
   */
  appendLog(service: ServiceName, text: string): void {
    const sink = this.sink;
    if (!sink) return;
    for (const line of redact(text, this.secrets).split(/\r?\n/))
      if (line.trim()) sink(`${service}: ${line}`);
  }

  /** Load the local web UI once healthy. The access key is never injected. */
  async openWebUi(): Promise<void> {
    await this.options.ports.openWebview(assertLoopback(webUrl).toString());
  }

  /**
   * Release timers and children. Polling stops and the handle is cleared, so a
   * closed controller can never reschedule itself or hold the process open.
   */
  async stopAll(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [, child] of this.children) await child.stop().catch(() => undefined);
    this.children.clear();
  }

  /** Compose teardown for the whole project. Callers must not add -v. */
  fullDown(): { program: string; args: string[]; cwd: string } {
    return {
      program: "docker",
      args: composeDown(this.options.paths),
      cwd: this.options.paths.root,
    };
  }
}
