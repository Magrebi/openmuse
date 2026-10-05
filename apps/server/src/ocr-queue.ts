/**
 * The background OCR queue.
 *
 * **Why this is its own loop and not the agent task worker.** The task worker
 * leases `AgentTask` records and drives them through the model's tool loop — its
 * lease, heartbeat and outcome vocabulary are all about delegated agent work. OCR
 * is none of that: no task, no model, no approval step, no events. Folding it in
 * would mean every scanned upload allocating a lease and a heartbeat for what is
 * really a bounded subprocess call. What it does share is the shape: durable
 * state in the same store, a reaper that refuses to start a second job for a
 * record it is already working on, and a stop() that waits for in-flight work.
 *
 * The queue itself is in memory and the *state* is durable. That is deliberate:
 * a job's outcome is written to the document record, so a restart mid-OCR leaves
 * the record "pending" and the next `start()` sweeps it up again. Nothing is lost
 * and there is no second scheduler to keep consistent with the first.
 */
import type { Config } from "./config.ts";
import { backgroundFailure } from "./log.ts";
import { availableLanguages, parseLanguages } from "./ocr.ts";

/** What the queue reports to the owner and the UI. */
export interface OcrQueueStatus {
  readonly running: number;
  readonly queued: number;
  /** True when a new OCR job would be refused because the queue is full. */
  readonly saturated: boolean;
  /** The languages the engine was actually built with. */
  readonly languages: string[];
}

export interface OcrJob {
  readonly owner: string;
  readonly documentId: string;
  /**
   * Do the OCR and return the text, or throw to mark the record failed.
   *
   * Supplied by `LibraryService`, which owns the on-disk layout and the search
   * index. The queue deliberately does not know where documents live.
   *
   * The signal is passed through to the subprocesses, so aborting a job on
   * shutdown actually kills the engine rather than merely marking the job: without
   * that, `stop()` waits out the full document timeout on every in-flight OCR.
   */
  readonly run: (
    signal: AbortSignal,
  ) => Promise<{ text: string; truncated: boolean; ocr: boolean }>;
}

export class OcrQueue {
  private readonly pending: OcrJob[] = [];
  private readonly active = new Map<string, AbortController>();
  private pumping = false;
  private stopping = false;
  private languages?: string[];
  /** Set once the engine has been probed, so a missing binary is reported once. */
  private probed = false;

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
    private readonly languagesSetting: string,
  ) {}

  /**
   * Whether a new OCR job would be accepted right now.
   *
   * Read by the caller to decide whether to refuse an upload. `enqueue`
   * re-checks, so two simultaneous uploads cannot both see room.
   */
  get saturated(): boolean {
    return this.pending.length + this.active.size >= this.maxQueue;
  }

  get status(): OcrQueueStatus {
    return {
      running: this.active.size,
      queued: this.pending.length,
      saturated: this.saturated,
      languages: this.languages ?? [],
    };
  }

  /**
   * Add a job, or report that it was not accepted.
   *
   * The duplicate guard is this repo's known worker-tick bug class: a document
   * already being OCR'd must not be queued a second time, or two Tesseract
   * processes would write the same index row and the last would silently win.
   */
  enqueue(job: OcrJob): boolean {
    if (this.active.has(job.documentId)) return false;
    if (this.pending.some((queued) => queued.documentId === job.documentId)) return false;
    if (this.saturated) return false;
    this.pending.push(job);
    this.pump();
    return true;
  }

  /** Start pumping. Safe to call more than once. */
  start() {
    this.stopping = false;
    this.pump();
  }

  /**
   * Stop after the in-flight jobs finish.
   *
   * Queued-but-unstarted jobs are dropped rather than drained on shutdown: they
   * are still "pending" in their record and the next `start()` sweeps them.
   * Running one on the way out would delay shutdown by up to a document timeout
   * for no benefit, since the work is recoverable either way.
   */
  async stop() {
    this.stopping = true;
    this.pending.length = 0;
    // A job in flight is aborted rather than awaited to completion: its record
    // goes back to "pending" on the failure path, so the next start re-runs it.
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size || this.pumping)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** Abort the job for one document, if it is running. */
  abort(documentId: string) {
    this.active.get(documentId)?.abort();
  }

  /** Take as many queued jobs as there is concurrency for, and start them. */
  private pump() {
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.concurrency && this.pending.length) {
        // `pending.length` is the guard above, so this shift cannot return
        // undefined; the loop is the only thing that removes entries.
        const job = this.pending.shift();
        if (!job) break;
        const controller = new AbortController();
        this.active.set(job.documentId, controller);
        void this.execute(job, controller);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(job: OcrJob, controller: AbortController) {
    try {
      await job.run(controller.signal);
    } catch (error) {
      // The record's own failure handling has already run inside `run`; this
      // catch exists so a rejection can never escape as an unhandled rejection
      // and take the process down. The document id is logged, never its content.
      backgroundFailure(`ocr ${job.documentId}`, error);
    } finally {
      this.active.delete(job.documentId);
      // A finished slot makes the next queued job startable.
      this.pump();
    }
  }

  /**
   * Probe the engine once, so a missing Tesseract shows up in the queue status
   * rather than as a silent per-document failure.
   *
   * Called after the server is listening: it spawns a process, and a status probe
   * that blocked the first request would be a self-inflicted slow start.
   */
  async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    try {
      const wanted = parseLanguages(this.languagesSetting);
      const installed = await availableLanguages();
      this.languages = installed;
      // A missing language is a configuration gap, not a crash: the documents
      // that need it will be marked failed and the rest keep working.
      const missing = wanted.split("+").filter((code) => !installed.includes(code));
      if (missing.length)
        backgroundFailure(
          "ocr languages",
          new Error(
            `not installed: ${missing.join(", ")}. Documents in those languages will not be recognised.`,
          ),
        );
    } catch (error) {
      backgroundFailure("ocr engine probe", error);
    }
  }
}

/** The queue configured from `Config`. */
export function createOcrQueue(config: Config): OcrQueue {
  return new OcrQueue(
    config.libraryOcrConcurrency ?? 2,
    config.libraryOcrMaxQueue ?? 8,
    config.libraryOcrLangs ?? "eng+tur",
  );
}
