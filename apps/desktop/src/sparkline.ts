/**
 * The tray's ambient read on what the agent is doing.
 *
 * A menu bar icon that only says "healthy" answers the question "is it on" and
 * nothing else. The interesting state of an agent is that it is *working* — a
 * long task looks identical to an idle one, which is the exact moment somebody
 * wonders whether it has stopped. So the tray draws recent activity as a
 * sparkline: present at a glance, absent when there is nothing to say.
 *
 * All of the logic lives here rather than in Rust because this is the part that
 * can be wrong in interesting ways — clamping, scaling, the gap between samples
 * — and because the desktop's TypeScript tests run in CI while its Rust does not
 * build in every environment. The Rust side is left to blit pixels it is handed.
 */

/** How many samples the sparkline keeps. Roughly a minute at a 1s poll. */
export const SPARK_SAMPLES = 48;

/** Above this many outstanding items, the agent is described as busy. */
export const BUSY_THRESHOLD = 1;

export interface SparkSample {
  /** Epoch milliseconds. */
  readonly at: number;
  /** How much work is outstanding. Negative is treated as zero. */
  readonly load: number;
}

/**
 * A bounded window of recent activity.
 *
 * Bounded because this lives in a process that runs for days: an unbounded
 * array here is a slow leak that would never show up in a test that only runs
 * for a minute.
 */
export class Sparkline {
  private readonly samples: SparkSample[] = [];

  constructor(private readonly capacity = SPARK_SAMPLES) {}

  /**
   * Record one reading. Older samples beyond the capacity are dropped.
   *
   * A zero load is *not* recorded. Idle time is the absence of work, and
   * recording it would draw a bar for it — so a tray watching an agent that has
   * nothing to do would show activity that is not happening. Leaving the buffer
   * untouched also lets the trace decay naturally: once there is work again, it
   * is drawn against the recent past rather than against a floor of zeros.
   */
  push(sample: SparkSample): void {
    const load = Number.isFinite(sample.load) ? Math.max(0, sample.load) : 0;
    if (load === 0) return;
    // Out-of-order samples would draw the line backwards, so they are refused
    // rather than sorted: a backwards clock should not corrupt what is on screen.
    const last = this.samples.at(-1);
    if (last && sample.at < last.at) return;
    this.samples.push({ at: sample.at, load });
    if (this.samples.length > this.capacity)
      this.samples.splice(0, this.samples.length - this.capacity);
  }

  /** The retained samples, oldest first. */
  history(): readonly SparkSample[] {
    return [...this.samples];
  }

  /** The most recent load, or zero when nothing has been seen. */
  get current(): number {
    return this.samples.at(-1)?.load ?? 0;
  }

  /** True when there is anything worth drawing. */
  get hasSignal(): boolean {
    return this.samples.length > 0;
  }

  /**
   * Points scaled into a `width`×`height` box, oldest first.
   *
   * Scaled against the window's own peak rather than an absolute scale, so a
   * quiet period still shows its shape instead of a flat line pinned to the
   * floor. A peak of zero is all zeros, which draws the baseline rather than
   * dividing by it.
   */
  points(width: number, height: number): { x: number; y: number }[] {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const peak = this.samples.reduce((max, sample) => Math.max(max, sample.load), 0);
    const last = this.widestIndex();
    return this.samples.map((sample, index) => ({
      x: last <= 0 ? 0 : Math.round((index / last) * (w - 1)),
      // `height - 1` because y grows downward and the floor is the last row.
      y: peak === 0 ? h - 1 : h - 1 - Math.round((sample.load / peak) * (h - 1)),
    }));
  }

  /** Where the trace starts, so a short history is right-aligned. */
  private widestIndex(): number {
    return Math.max(0, this.samples.length - 1);
  }

  /**
   * One line for the tray tooltip.
   *
   * No idle branch, because idle is never recorded: a buffer with nothing in it
   * has seen no work at all, which is the honest thing to say and is also what
   * tells somebody the agent has not started rather than has just finished.
   */
  summary(): string {
    if (!this.hasSignal) return "no activity yet";
    const load = this.current;
    return load === 1 ? "1 item in flight" : `${load} items in flight`;
  }
}
