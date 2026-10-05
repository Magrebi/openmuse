/**
 * The OCR engine: Tesseract for text recognition, poppler's `pdftoppm` for
 * rendering a scanned PDF page to an image.
 *
 * Both are local binaries. There is no cloud OCR here and no model download on
 * first use: document bytes never leave the box, which is the whole reason to
 * self-host. The language data is read from a local directory, so the first run
 * behaves exactly like every run after it.
 *
 * **Subprocess safety is the load-bearing property of this file.** Two rules,
 * both pinned by tests:
 *
 * 1. Every invocation goes through `run`, which uses `spawn` with `shell: false`
 *    and an argv array. There is no shell, so there is no word-splitting,
 *    glob-expansion or metacharacter interpretation to defend against.
 * 2. No client-controlled value ever becomes an argument. Filenames are built
 *    from the server-generated document id and a UUID, in a directory this
 *    process owns. Language codes are validated against a strict pattern before
 *    use. Everything else is a fixed flag or a numeric range.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the local language data lives. Nothing is fetched at runtime. */
const TESSDATA_PREFIX = process.env.TESSDATA_PREFIX ?? "";

/** Language codes: three letters, optionally joined by `+`. Anything else is refused. */
const LANGUAGE_PATTERN = /^[a-z]{3}(\+[a-z]{3}){0,8}$/;

/** Cap on one subprocess's captured output, so a chatty engine cannot grow the heap. */
const OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface OcrProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
}

/**
 * Run one local binary to completion, with a hard timeout.
 *
 * Mirrors `runDocker` in computer.ts, the repo's established shape for a
 * subprocess: argv-only spawn, a SIGKILL on timeout rather than a polite signal,
 * and bounded output capture. A timeout kills the process outright — Tesseract
 * wedged on a malformed image must not hold a queue slot forever.
 *
 * Never rejects: a missing binary, a non-zero exit and a timeout are all reported
 * through the result, so callers handle them explicitly rather than inheriting an
 * exception from deep inside a callback.
 */
export function run(
  program: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string } = { timeoutMs: 60_000 },
): Promise<OcrProcessResult> {
  return new Promise((resolve) => {
    const result: OcrProcessResult = {
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      interrupted: false,
      truncated: false,
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let count = 0;
    let settled = false;
    // Set by the `error` handler below and appended by `finish`. It has to be a
    // separate variable because `finish` assigns `result.stderr` from the
    // captured stream, which would otherwise overwrite whatever the error handler
    // wrote — leaving a missing binary indistinguishable from a silent success.
    let launchError = "";
    // A minimal environment. The child must not inherit the API's provider keys,
    // and the one variable that matters below is the only one that redirects
    // where Tesseract loads its data from.
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    if (TESSDATA_PREFIX) env.TESSDATA_PREFIX = TESSDATA_PREFIX;
    const child = spawn(program, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      result.stdout = Buffer.concat(stdout).toString("utf8");
      result.stderr = [Buffer.concat(stderr).toString("utf8"), launchError]
        .filter(Boolean)
        .join("\n");
      resolve(result);
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, OUTPUT_LIMIT - count);
      if (chunk.length > remaining) result.truncated = true;
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      count += Math.min(remaining, chunk.length);
    };
    const kill = (interrupted: boolean) => {
      result.interrupted = interrupted;
      child.kill("SIGKILL");
      finish();
    };
    const abort = () => kill(true);
    const timer = setTimeout(() => {
      result.timedOut = true;
      kill(false);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", () => {
      // ENOENT lands here: the engine is not installed. Reported as a result
      // rather than thrown, so the caller marks the document failed and moves on.
      launchError = `${program} is not available on this host`;
      finish();
    });
    child.on("close", (code) => {
      result.exitCode = code;
      finish();
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

/**
 * The languages the engine was built with.
 *
 * Read from the local binary rather than from configuration, because the point is
 * to discover what is actually installed: `LIBRARY_OCR_LANGS=eng+tur` on a host
 * that only has `eng` would otherwise fail at recognition time, per document,
 * instead of once at startup where an operator can act on it.
 */
export async function availableLanguages(): Promise<string[]> {
  const result = await run("tesseract", ["--list-langs"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return [];
  // The first line is a header naming the data directory; the rest are codes.
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z]{3}$/.test(line));
}

/**
 * Normalise the configured language list.
 *
 * `LIBRARY_OCR_LANGS` is an operator-supplied value that becomes a subprocess
 * argument, so it is validated rather than trusted: only `[a-z]{3}` codes joined
 * by `+` survive, and anything else falls back to the default. Even without a
 * shell an unvalidated value does not belong in argv.
 */
export function parseLanguages(raw: string | undefined, fallback = "eng+tur"): string {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (!LANGUAGE_PATTERN.test(value))
    throw new Error(
      `LIBRARY_OCR_LANGS must be language codes joined by "+" (for example "eng+tur"), got "${raw}"`,
    );
  return value;
}

/**
 * Recognise text in one image file.
 *
 * `tesseract <input> stdout -l <langs>` writes the recognised text to stdout,
 * which is why the output basename is the literal `stdout` — no temporary file
 * and no second path to clean up.
 *
 * Both paths are constructed here, never taken from a caller: `imagePath` is a
 * path this process created inside its own scratch directory, and `langs` has
 * been through `parseLanguages`. The OCR output is untrusted text — Tesseract
 * hallucinates, and a hostile image can render arbitrary glyphs — so it is
 * returned as data for the caller to fence, never as anything else.
 */
export async function recognise(
  imagePath: string,
  languages: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ text: string; ok: boolean; reason?: string }> {
  const result = await run(
    "tesseract",
    // `--psm 3` is the default page-segmentation mode (auto-detect), which is
    // the right guess for a photo of a page. `quiet` keeps the progress chatter
    // off stderr so a real error is the only thing there.
    [imagePath, "stdout", "-l", languages, "--psm", "3", "quiet"],
    { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
  );
  if (result.interrupted) return { text: "", ok: false, reason: "interrupted" };
  if (result.timedOut) return { text: "", ok: false, reason: "timed out" };
  if (result.exitCode !== 0)
    return { text: "", ok: false, reason: result.stderr.trim() || `exit ${result.exitCode}` };
  return { text: result.stdout, ok: true };
}

/** Rendered page images from a PDF, and the text recognised in them. */
export interface OcrPage {
  readonly page: number;
  readonly text: string;
  /** True when this page's text came from OCR rather than a PDF text layer. */
  readonly ocr: boolean;
}

/** Render one PDF page to a PNG and recognise it. */
async function ocrPdfPage(
  pdfPath: string,
  page: number,
  directory: string,
  languages: string,
  options: { pageTimeoutMs: number; renderDpi: number; signal?: AbortSignal },
): Promise<OcrPage> {
  // The page number is a loop index, not caller input, but it is formatted here
  // rather than interpolated so it is provably a small integer at argv time.
  const pageArg = String(Math.max(1, Math.floor(page)));
  const prefix = join(directory, `page-${pageArg}`);
  // `pdftoppm -r <dpi>` sets the raster resolution. 200 DPI is the usual
  // compromise: legible for body text, and small enough that a page is a few
  // MB of PNG rather than a memory bomb.
  const rendered = await run(
    "pdftoppm",
    ["-png", "-r", String(options.renderDpi), "-f", pageArg, "-l", pageArg, pdfPath, prefix],
    { timeoutMs: options.pageTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
  );
  if (rendered.interrupted) return { page, text: "", ocr: true };
  if (rendered.timedOut) return { page, text: "", ocr: true };
  if (rendered.exitCode !== 0) return { page, text: "", ocr: true };
  // pdftoppm appends the page number: `page-3.png`, and zero-pads it for pages
  // ≥ 10 in some builds. Read what it actually wrote rather than assuming a name.
  const written = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`page-${pageArg}`) && name.endsWith(".png"))
    .sort();
  if (!written.length) return { page, text: "", ocr: true };
  const rendered0 = written[0];
  if (!rendered0) return { page, text: "", ocr: true };
  const recognised = await recognise(join(directory, rendered0), languages, {
    timeoutMs: options.pageTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { page, text: recognised.ok ? recognised.text : "", ocr: true };
}

/**
 * Characters a PDF page must yield from its text layer before OCR is considered.
 *
 * A scanned page typically yields zero characters; a page with a header or a page
 * number might yield a handful. Ten is low enough to catch a page that carries
 * only furniture, and high enough that real body text is never re-OCR'd — OCR of
 * a page that already has usable text is both slow and less accurate than the
 * text layer it would be replacing.
 */
export const TEXT_LAYER_THRESHOLD = 10;

/**
 * Recognise the scanned pages of a PDF, rendering each page on demand.
 *
 * The caller supplies the per-page text-layer results, so a hybrid document keeps
 * its real text where it has one and gets OCR only for the pages that need it —
 * and both arrive in page order, which is the order a human reads in.
 *
 * `maxPages` bounds the work: past it, processing stops and the result is marked
 * truncated, matching the convention text extraction already uses. An unbounded
 * page count is the difference between a 20-page invoice and a 500-page manual
 * that ties up the queue for an hour.
 *
 * Every rendered page goes to one scratch directory that is removed in a
 * `finally`, however this function exits.
 */
export async function recogniseScannedPdf(
  pdfPath: string,
  pages: { page: number; text: string }[],
  languages: string,
  options: {
    maxPages: number;
    pageTimeoutMs: number;
    documentTimeoutMs: number;
    renderDpi: number;
    signal?: AbortSignal;
  },
): Promise<{ pages: OcrPage[]; truncated: boolean }> {
  const merged: OcrPage[] = [];
  let scanned = 0;
  let truncated = false;
  const deadline = Date.now() + options.documentTimeoutMs;
  const directory = await mkdtemp(join(tmpdir(), "openmuse-ocr-"));
  try {
    for (const page of pages) {
      // Once aborted, stop entirely. Each remaining page would otherwise still
      // spawn a `pdftoppm` and a `tesseract` that are killed the instant they
      // start — up to forty pointless process launches on a twenty-page document,
      // exactly during the shutdown that is trying to move quickly.
      if (options.signal?.aborted) {
        truncated = true;
        continue;
      }
      // A page with a usable text layer costs nothing, so it is never counted
      // against the page budget and never rendered.
      if (page.text.trim().length >= TEXT_LAYER_THRESHOLD) {
        merged.push({ page: page.page, text: page.text, ocr: false });
        continue;
      }
      if (scanned >= options.maxPages || Date.now() > deadline) {
        // Past the budget, or out of time. The page is dropped rather than
        // rendered empty, so `truncated` is the honest signal that pages are
        // missing rather than that a page happened to be blank.
        truncated = true;
        continue;
      }
      scanned++;
      merged.push(
        await ocrPdfPage(pdfPath, page.page, directory, languages, {
          pageTimeoutMs: options.pageTimeoutMs,
          renderDpi: options.renderDpi,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  merged.sort((a, b) => a.page - b.page);
  return { pages: merged, truncated };
}
