import type { DesktopErrorCode } from "./errors.js";

/**
 * The deployment's single source of truth. The tray, the status page and OS
 * notifications all render from this value; no surface keeps a parallel copy.
 * Transitions are driven only by compose exit codes and `GET /api/health`.
 */
export type DeploymentState =
  | "unknown"
  | "stopped"
  | "starting"
  | "healthy"
  | "degraded"
  | "error"
  | "stopping";

export type HealthProbe = "healthy" | "degraded" | "stopped" | "unreachable";

export type DeploymentEvent =
  | { type: "PROBE"; result: HealthProbe; reason?: string }
  | { type: "UP_REQUESTED" }
  | { type: "HEALTH_OK" }
  | { type: "HEALTH_PARTIAL"; reason?: string }
  | { type: "HEALTH_FAIL" }
  | { type: "COMPOSE_FAILED"; code?: DesktopErrorCode; reason?: string }
  | { type: "START_TIMEOUT" }
  | { type: "DOWN_REQUESTED" }
  | { type: "DOWN_EXIT_OK" }
  | { type: "DOWN_EXIT_FAIL"; reason?: string }
  | { type: "RESET" };

export interface Deployment {
  readonly state: DeploymentState;
  /** A code or short phrase explaining the current state. Never a stack trace. */
  readonly reason?: string;
  readonly code?: DesktopErrorCode;
  /** Bounded transition log, so a surface can detect a change it missed. */
  readonly history: readonly DeploymentState[];
  /** Bumped on every change. Subscribers compare this to redraw. */
  readonly revision: number;
}

export const initialDeployment = (): Deployment => ({
  state: "unknown",
  history: ["unknown"],
  revision: 0,
});

/** States in which the stack is up or coming up. */
export const activeStates: readonly DeploymentState[] = [
  "starting",
  "healthy",
  "degraded",
  "stopping",
];

export type Tone = "gray" | "green" | "amber" | "red";

/** Tray and status dot colour. One derivation, so they can never disagree. */
export function toneFor(state: DeploymentState): Tone {
  switch (state) {
    case "healthy":
      return "green";
    case "degraded":
    case "starting":
    case "stopping":
      return "amber";
    case "error":
      return "red";
    default:
      return "gray";
  }
}

function resolve(state: DeploymentState, event: DeploymentEvent): DeploymentState {
  switch (event.type) {
    // The launch probe is the only way out of `unknown`.
    case "PROBE":
      return state === "unknown" && event.result !== "unreachable" ? event.result : state;
    case "UP_REQUESTED":
      return state === "stopped" || state === "error" ? "starting" : state;
    case "HEALTH_OK":
      if (state === "starting" || state === "degraded" || state === "healthy") return "healthy";
      return state;
    case "HEALTH_PARTIAL":
      if (state === "starting" || state === "healthy" || state === "degraded") return "degraded";
      return state;
    // While starting, an unreachable API is expected; the start timeout decides.
    case "HEALTH_FAIL":
      return state === "healthy" ? "degraded" : state;
    case "COMPOSE_FAILED":
      return activeStates.includes(state) || state === "stopped" ? "error" : state;
    case "START_TIMEOUT":
      return activeStates.includes(state) || state === "stopped" ? "error" : state;
    case "DOWN_REQUESTED":
      return state === "unknown" ? state : "stopping";
    case "DOWN_EXIT_OK":
      return state === "stopping" ? "stopped" : state;
    case "DOWN_EXIT_FAIL":
      return state === "stopping" ? "error" : state;
    case "RESET":
      return "unknown";
    default:
      return state;
  }
}

function detailOf(event: DeploymentEvent): { reason?: string; code?: DesktopErrorCode } {
  switch (event.type) {
    case "DOWN_EXIT_FAIL":
      return { reason: event.reason };
    case "COMPOSE_FAILED":
      return { reason: event.reason, code: event.code };
    case "START_TIMEOUT":
      return { reason: "OpenMuse did not become healthy in time", code: "COMPOSE_TIMEOUT" };
    case "HEALTH_OK":
      return { reason: "API and browser worker are healthy" };
    case "HEALTH_PARTIAL":
      // Prefer the specific line from the health layer over a generic message.
      return { reason: event.reason ?? "API is up but not fully configured" };
    case "HEALTH_FAIL":
      return { reason: "Health check failed" };
    case "PROBE":
      return event.result === "stopped" ? { reason: "Stack is stopped" } : { reason: event.reason };
    default:
      return {};
  }
}

export function transition(deployment: Deployment, event: DeploymentEvent): Deployment {
  const state = resolve(deployment.state, event);
  const detail = detailOf(event);
  // A health poll that does not change the state must not move the revision, so
  // surfaces redraw only on real transitions.
  if (state === deployment.state && !detail.reason && !detail.code) return deployment;
  return {
    state,
    reason: detail.reason,
    code: detail.code,
    history: [...deployment.history, state].slice(-32),
    revision: deployment.revision + 1,
  };
}
