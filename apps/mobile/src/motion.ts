/**
 * Motion tokens, and the physics OpenMuse's animation is defined in terms of.
 *
 * Every animated surface — the mascot's breathing, the shared element a
 * `TaskCard` becomes when it expands, the height of a streaming tool card —
 * resolves to one of the springs or durations below. Keeping them in one place
 * is what makes the app feel like one system rather than a pile of transitions
 * that each invented their own curve.
 *
 * This module deliberately imports nothing from React or React Native, so both
 * the tokens and the samplers below can be tested under plain Node.
 */

/**
 * A spring in Reanimated's parameterisation.
 *
 * `stiffness` is how hard the value is pulled toward its target, `damping` how
 * fast the oscillation dies, and `mass` how much inertia it carries.
 */
export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
  readonly overshootClamping: boolean;
  readonly restDisplacementThreshold: number;
  readonly restSpeedThreshold: number;
}

/** The springs the app uses, named for the job rather than for their numbers. */
export const springs = {
  /**
   * Sheets, modals and detail views. Arrives with a little weight and settles
   * without bouncing, because a sheet that wobbles reads as broken.
   */
  gentle: {
    stiffness: 190,
    damping: 26,
    mass: 1,
    overshootClamping: false,
    restDisplacementThreshold: 0.4,
    restSpeedThreshold: 2,
  },
  /**
   * Direct manipulation: pressed states, chips, small affordances. Fast and
   * near critically damped, so a finger never waits on the animation.
   */
  snappy: {
    stiffness: 420,
    damping: 32,
    mass: 0.8,
    overshootClamping: true,
    restDisplacementThreshold: 0.2,
    restSpeedThreshold: 4,
  },
  /**
   * The shared element a `TaskCard` becomes. Deliberately under-damped, so the
   * expansion carries the momentum of the card the finger was already moving.
   */
  shared: {
    stiffness: 210,
    damping: 21,
    mass: 1,
    overshootClamping: false,
    restDisplacementThreshold: 0.3,
    restSpeedThreshold: 1.5,
  },
  /**
   * Heights of streaming text. Two properties matter more than the others.
   *
   * Overshoot is clamped, because a spring that carries *past* its target sends
   * every arriving line beyond its final height and snaps it back — which is
   * exactly the scroll jump this exists to remove.
   *
   * It is also the stiffest of the four, critically damped (ζ = 1.0) with a rest
   * threshold of 3px. Both numbers are deliberate. More stiffness overshoots the
   * threshold into an overdamped regime whose slow tail reads as the text
   * lagging behind what the agent already said; and a stricter threshold costs
   * hundreds of milliseconds to reach sub-pixel accuracy that nobody can see on
   * a growing text box. At these values a line lands in ~256ms, inside the
   * interval at which the next line of text arrives, and is clamped so it never
   * passes its final height.
   */
  streaming: {
    stiffness: 450,
    damping: 40,
    mass: 0.9,
    overshootClamping: true,
    restDisplacementThreshold: 3,
    restSpeedThreshold: 60,
  },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof springs;

/** Durations for work that is genuinely time-based rather than physical. */
export const durations = {
  /** Press feedback and any state a finger is already waiting on. */
  instant: 90,
  /** Opacity and tint changes. */
  quick: 160,
  /** The default for one element entering or leaving. */
  base: 260,
  /** A larger surface: sheet contents, detail body. */
  slow: 380,
  /** Used sparingly, where a beat of anticipation helps comprehension. */
  deliberate: 560,
} as const satisfies Record<string, number>;
/** Clamp to the unit interval. */
export const clamp01 = (value: number): number => {
  // Infinities clamp to the nearest bound, which is what "clamp" means; only
  // NaN — a value with no position at all — falls back to 0.
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
};

/** Clamp to a closed range, treating infinities as out-of-range and NaN as low. */
export const clamp = (value: number, low: number, high: number): number => {
  if (Number.isNaN(value)) return low;
  return value < low ? low : value > high ? high : value;
};

/** Linear interpolation between `from` and `to`. */
export const lerp = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

/**
 * Position of `value` inside `[from, to]` as a 0..1 fraction.
 *
 * A zero-width or reversed range has no meaningful position for the value, so
 * both yield 0 rather than `NaN` or a spurious midpoint. Two failure modes are
 * being avoided: an animation driver handed `NaN` stops rendering altogether,
 * so one bad input would freeze a surface rather than merely misplace it, and
 * clamping a reversed range would hide the caller's own mistake.
 */
export const normalize = (value: number, from: number, to: number): number => {
  const span = to - from;
  if (!Number.isFinite(span) || !Number.isFinite(value) || span <= 0) return 0;
  return clamp01((value - from) / span);
};

/**
 * Delay for the `index`th item of a list entering or leaving, capped so a long
 * transcript finishes animating shortly after the person stopped reading it.
 */
export const stagger = (index: number, step = 34, max = 320): number =>
  !Number.isFinite(index) || index <= 0 ? 0 : Math.min(max, index * step);

/**
 * A sine oscillator sampled at `timeMs`, in the range [-1, 1].
 *
 * The mascot's breathing and aura run on this rather than on a keyframe
 * sequence: a continuous function can be sampled anywhere, so the animation can
 * start, stop or reverse mid-cycle without a jump, and phase comes from a
 * timestamp instead of from counting frames.
 */
export const wave = (timeMs: number, periodMs: number): number => {
  if (!Number.isFinite(timeMs) || !Number.isFinite(periodMs) || periodMs <= 0) return 0;
  return Math.sin((timeMs / periodMs) * Math.PI * 2);
};

/** The value, velocity and rest state of a spring at one instant. */
export interface SpringSample {
  /** Displacement remaining from the target, in the target's own units. */
  readonly displacement: number;
  readonly velocity: number;
  /** True once the spring is within both of its rest thresholds. */
  readonly settled: boolean;
}

/**
 * One Euler step of a damped spring travelling from `displacement` toward 0.
 *
 * The UI hands this work to Reanimated, which integrates on the UI thread. It
 * lives here as well so the *behaviour* of each named spring — in particular
 * that `streaming` never overshoots and that `gentle` settles — is something a
 * test can assert rather than something a designer has to eyeball.
 */
export const stepSpring = (
  spring: Spring,
  displacement: number,
  velocity: number,
  dtSeconds: number,
): SpringSample => {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0)
    return { displacement, velocity, settled: true };
  const { stiffness, damping, mass, overshootClamping, restDisplacementThreshold } = spring;
  const safeMass = mass > 0 && Number.isFinite(mass) ? mass : 1;
  const springForce = -stiffness * displacement;
  const damperForce = -damping * velocity;
  const nextVelocity = velocity + ((springForce + damperForce) / safeMass) * dtSeconds;
  const raw = displacement + nextVelocity * dtSeconds;
  // A clamped spring that has crossed its target is *at* the target: leaving a
  // non-zero displacement there would make the value re-accelerate away from it.
  const crossed =
    overshootClamping && displacement !== 0 && Math.sign(raw) !== Math.sign(displacement);
  const displacementOut = crossed ? 0 : raw;
  const velocityOut = crossed ? 0 : nextVelocity;
  return {
    displacement: displacementOut,
    velocity: velocityOut,
    settled:
      Math.abs(displacementOut) <= restDisplacementThreshold &&
      Math.abs(velocityOut) <= spring.restSpeedThreshold,
  };
};

/**
 * Run a spring from an initial displacement to rest, sampling every `stepMs`.
 *
 * `overshoot` reports the largest excursion *past* the target — a signed
 * quantity, so the caller can tell an under-damped spring from a critically
 * damped one. It is 0 for a spring that only ever approaches from one side,
 * which is exactly the property the streaming-height spring must have.
 * `settledAtMs` is when it first came to rest, or `null` if it never did.
 */
export const sampleSpring = (
  spring: Spring,
  initialDisplacement: number,
  options: { stepMs?: number; maxMs?: number; initialVelocity?: number } = {},
): { samples: SpringSample[]; overshoot: number; settledAtMs: number | null } => {
  const stepMs = options.stepMs ?? 16;
  const maxMs = options.maxMs ?? 4000;
  const samples: SpringSample[] = [];
  let displacement = initialDisplacement;
  let velocity = options.initialVelocity ?? 0;
  // Excursion past the target is measured against the side the spring started
  // on: anything on the far side of zero is past it.
  const startSign = Math.sign(initialDisplacement) || 1;
  let overshoot = 0;
  let settledAtMs: number | null = null;
  for (let time = 0; time <= maxMs; time += stepMs) {
    const next = stepSpring(spring, displacement, velocity, stepMs / 1000);
    displacement = next.displacement;
    velocity = next.velocity;
    const past = -startSign * displacement;
    if (past > 0) overshoot = Math.max(overshoot, past);
    samples.push(next);
    if (next.settled) {
      settledAtMs = time;
      break;
    }
  }
  return { samples, overshoot, settledAtMs };
};
