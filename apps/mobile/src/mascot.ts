/**
 * The mascot's state machine.
 *
 * The capybara is the one element on screen that never sits still, so its
 * behaviour has to be a function of *what the agent is actually doing* rather
 * than of what any individual screen happened to pass in. This module owns that
 * decision: given the facts the app already knows — is the model streaming, is
 * the browser open, is a task running, is a person waiting on us — it returns
 * one of six states plus the geometry for that state.
 *
 * It has no React and no React Native import so the whole machine is testable
 * under plain Node.
 */

import { clamp, clamp01, springs, wave } from "./motion.ts";

/**
 * The six states the mascot can be in.
 *
 * Each is a genuinely different posture rather than a recolour, because the
 * point is that a person can tell what the agent is doing from across the room
 * without reading any text.
 */
export type MascotState =
  /** Nothing to do. Slow, wide breathing. */
  | "idle"
  /** The person is speaking. Leaned in, quick shallow breaths. */
  | "listening"
  /** The model is producing tokens. Held still, a small thinking pulse. */
  | "thinking"
  /** A page is open and being read. Low, forward-leaning drift. */
  | "browsing"
  /** A task needs an answer. Nearly motionless, attention raised. */
  | "waiting"
  /** Something finished. One bounce, then back to idle. */
  | "celebrating";

export const mascotStates: readonly MascotState[] = [
  "idle",
  "listening",
  "thinking",
  "browsing",
  "waiting",
  "celebrating",
];

/** Everything the mascot's posture is computed from. */
export interface MascotSignals {
  /** The model is streaming a reply. */
  streaming?: boolean;
  /** The microphone is capturing. */
  listening?: boolean;
  /** A browser session is open or being driven. */
  browsing?: boolean;
  /** A task is running. */
  working?: boolean;
  /** A task is waiting on the person. */
  awaitingInput?: boolean;
  /** A task just reached a terminal successful state. */
  justSucceeded?: boolean;
  /** The agent is unreachable. */
  offline?: boolean;
}

/**
 * Resolve the signals into one state.
 *
 * The order is deliberate and is the whole precedence rule: a person speaking
 * outranks everything, because a mascot that keeps thinking while you talk is
 * not listening; a blocked task outranks a running one, because needing you is
 * more urgent than making progress; and success outranks ordinary work for one
 * beat so the win is legible before it decays.
 */
export const resolveMascotState = (signals: MascotSignals = {}): MascotState => {
  if (signals.listening) return "listening";
  if (signals.justSucceeded) return "celebrating";
  if (signals.awaitingInput) return "waiting";
  if (signals.streaming) return "thinking";
  if (signals.browsing) return "browsing";
  if (signals.working) return "thinking";
  if (signals.offline) return "waiting";
  return "idle";
};

/** The animated geometry of one state. All values are resolved, not tokens. */
export interface MascotPosture {
  readonly state: MascotState;
  /** Uniform scale of the whole figure. */
  readonly scale: number;
  /** Vertical bob, in fractions of the figure's height, at the extremes. */
  readonly bob: number;
  /** Rotation in degrees at the extremes; negative leans left. */
  readonly tilt: number;
  /** Horizontal lean as a fraction of width; positive leans right. */
  readonly lean: number;
  /** One breath cycle in milliseconds. */
  readonly breathPeriodMs: number;
  /** How far the chest travels per breath, 0..1. */
  readonly breathDepth: number;
  /** Eye aperture, 0 closed .. 1 wide. */
  readonly eyeOpen: number;
  /** Pupil radius, 0..1 of the eye. */
  readonly pupil: number;
  /** Halo opacity, 0..1. */
  readonly aura: number;
  /** Halo radius as a multiple of the figure's radius. */
  readonly auraScale: number;
  /** Accent colour for this state. */
  readonly tint: string;
  /** Milliseconds the celebration bounce lasts. */
  readonly celebrateMs: number;
}

/** Eye aperture is animated separately so a state change blinks once. */
const eyeFor = (state: MascotState): number => {
  switch (state) {
    case "waiting":
      return 1;
    case "thinking":
      return 0.45;
    case "celebrating":
      return 0.2;
    default:
      return 0.85;
  }
};

const tintFor = (state: MascotState): string => {
  switch (state) {
    case "listening":
      return "#7FC4A4";
    case "thinking":
      return "#6AAEE0";
    case "browsing":
      return "#8FA6E8";
    case "waiting":
      return "#E0A85A";
    case "celebrating":
      return "#7FC4A4";
    default:
      return "#C8E7FF";
  }
};

/**
 * The static posture of a state.
 *
 * Deliberately pure: it takes no clock. All time-varying motion is derived from
 * `mascotFrame` below, so a test can assert the posture of every state without
 * waiting, and the UI can keep sampling at 60fps without this function doing
 * per-frame work.
 */
export const mascotPosture = (state: MascotState): MascotPosture => {
  switch (state) {
    case "listening":
      return {
        state,
        scale: 1.04,
        bob: 0.006,
        tilt: -1.5,
        lean: 0.02,
        breathPeriodMs: 1900,
        breathDepth: 0.5,
        eyeOpen: eyeFor(state),
        pupil: 0.42,
        aura: 0.4,
        auraScale: 1.3,
        tint: tintFor(state),
        celebrateMs: 0,
      };
    case "thinking":
      return {
        state,
        scale: 0.98,
        bob: 0.004,
        tilt: 2.5,
        lean: -0.01,
        breathPeriodMs: 3400,
        breathDepth: 0.18,
        eyeOpen: eyeFor(state),
        pupil: 0.3,
        aura: 0.28,
        auraScale: 1.18,
        tint: tintFor(state),
        celebrateMs: 0,
      };
    case "browsing":
      return {
        state,
        scale: 1.0,
        bob: 0.008,
        tilt: -3,
        lean: 0.05,
        breathPeriodMs: 2600,
        breathDepth: 0.3,
        eyeOpen: eyeFor(state),
        pupil: 0.55,
        aura: 0.34,
        auraScale: 1.22,
        tint: tintFor(state),
        celebrateMs: 0,
      };
    case "waiting":
      return {
        state,
        scale: 0.96,
        bob: 0.012,
        tilt: 0,
        lean: 0,
        breathPeriodMs: 4400,
        breathDepth: 0.22,
        eyeOpen: eyeFor(state),
        pupil: 0.6,
        aura: 0.5,
        auraScale: 1.34,
        tint: tintFor(state),
        celebrateMs: 0,
      };
    case "celebrating":
      return {
        state,
        scale: 1.08,
        bob: 0.026,
        tilt: 0,
        lean: 0,
        breathPeriodMs: 1200,
        breathDepth: 0.12,
        eyeOpen: eyeFor(state),
        pupil: 0.35,
        aura: 0.72,
        auraScale: 1.6,
        tint: tintFor(state),
        celebrateMs: 1400,
      };
    default:
      return {
        state: "idle",
        scale: 1,
        bob: 0.005,
        tilt: 0,
        lean: 0,
        breathPeriodMs: 5200,
        breathDepth: 0.28,
        eyeOpen: eyeFor(state),
        pupil: 0.5,
        aura: 0.22,
        auraScale: 1.14,
        tint: tintFor(state),
        celebrateMs: 0,
      };
  }
};

/** One rendered frame of the mascot. */
export interface MascotFrame extends MascotPosture {
  /** 0..1 breath phase, useful for driving a second, offset part. */
  readonly breath: number;
}

/**
 * Sample the mascot at `timeMs`.
 *
 * A celebration decays on its own: the bounce is an envelope over `timeMs` that
 * peaks once and returns to the idle posture, so the caller can simply render
 * and the mascot cannot get stuck mid-bounce if a re-render is missed.
 */
export const mascotFrame = (state: MascotState, timeMs: number): MascotFrame => {
  const posture = mascotPosture(state);
  const breath = wave(timeMs, posture.breathPeriodMs);
  const celebrating = state === "celebrating";
  // One sharp rise and a longer settle: a symmetric bounce reads as a metronome.
  const envelope = celebrating ? Math.exp(-Math.max(0, timeMs) / 420) : 0;
  const hop = celebrating ? Math.max(0, wave(timeMs - 140, 900)) * envelope : 0;
  return {
    ...posture,
    bob: clamp(posture.bob * breath - hop * 0.9, -0.4, 0.4),
    scale: clamp01(posture.scale + (celebrating ? envelope * 0.06 : 0)),
    tilt: posture.tilt * breath,
    lean: posture.lean * (1 + breath),
    eyeOpen: clamp01(posture.eyeOpen - Math.max(0, breath) * 0.06),
    aura: clamp01(posture.aura + (celebrating ? envelope * 0.25 : 0)),
    breath: clamp01((breath + 1) / 2),
  };
};

/**
 * Spring to use when moving *between* states.
 *
 * A state change is a discrete event, so it gets a physical settle rather than
 * the breathing curve: `gentle` for everything except a celebration, which
 * bounces on the way in because that is the whole sensation of winning.
 */
export const mascotSpring = (state: MascotState) =>
  state === "celebrating" ? springs.shared : springs.gentle;

/** How long the celebration animation runs before returning to idle. */
export const celebrationDurationMs = (state: MascotState): number =>
  mascotPosture(state).celebrateMs;

/**
 * A short label for each state, for the accessibility label on the figure.
 *
 * A screen reader user gets the same information a sighted user reads off the
 * posture, so the mascot is never decoration-only.
 */
export const mascotLabel = (state: MascotState): string => {
  switch (state) {
    case "listening":
      return "OpenMuse is listening";
    case "thinking":
      return "OpenMuse is working";
    case "browsing":
      return "OpenMuse is browsing";
    case "waiting":
      return "OpenMuse needs your input";
    case "celebrating":
      return "OpenMuse finished a task";
    default:
      return "OpenMuse is idle";
  }
};
