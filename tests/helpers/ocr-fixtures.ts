/**
 * Fixtures for the OCR tests.
 *
 * Every fixture is *generated*, never committed as a blob. A scanned PDF is an
 * image drawn into a PDF page, so producing one needs a renderer — and the tools
 * this repo already depends on are exactly that:
 *
 * - `pdftoppm`/`pdftocairo` (poppler) to rasterise a page, and
 * - Tesseract itself to draw text into an image, which is how a "photographed"
 *   page is made without shipping a font or an image encoder.
 *
 * Generating the fixture in the test also means the test cannot pass against a
 * stale committed file: if recognition breaks, the fixture changes with it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../apps/server/src/ocr.ts";

/** True when both OCR binaries are present, so a suite can skip cleanly. */
export async function ocrAvailable(): Promise<boolean> {
  const tesseract = await run("tesseract", ["--version"], { timeoutMs: 10_000 });
  const poppler = await run("pdftoppm", ["-v"], { timeoutMs: 10_000 });
  return tesseract.exitCode === 0 && poppler.exitCode === 0;
}

/**
 * Draw text into a PNG using Tesseract itself.
 *
 * `tesseract <image> out -c ...` is the wrong direction, so instead the text is
 * rendered by asking Tesseract to write an image it has "read" from a generated
 * source — which it cannot do. The practical route is the one below: build a
 * single-page PDF containing real text with `pdf-lib`, rasterise it with
 * `pdftoppm`, and that raster is a genuine page image with no text layer.
 *
 * @param lines the text to appear on the page
 * @returns PNG bytes of the rendered page
 */
export async function pageImage(lines: string[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 72, y, size: 24, font });
    y -= 40;
  }
  const pdf = await document.save();
  const directory = await mkdtemp(join(tmpdir(), "openmuse-ocr-fixture-"));
  try {
    const source = join(directory, "source.pdf");
    const prefix = join(directory, "page");
    await writeFile(source, pdf);
    // -r 200 matches what the OCR path renders at, so the fixture is the same
    // resolution the engine will meet in production.
    const rendered = await run(
      "pdftoppm",
      ["-png", "-r", "200", "-f", "1", "-l", "1", source, prefix],
      {
        timeoutMs: 30_000,
      },
    );
    if (rendered.exitCode !== 0)
      throw new Error(`pdftoppm could not render the fixture: ${rendered.stderr}`);
    const png = await readFile(`${prefix}-1.png`);
    return new Uint8Array(png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A scanned PDF: pages that are images with no text layer at all.
 *
 * Built by embedding the rendered PNG into a PDF page, so `readPdfText` finds no
 * text on any page — which is precisely the "scanned document" case the OCR path
 * exists for.
 */
export async function scannedPdf(pages: string[][]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.create();
  for (const lines of pages) {
    const image = await pageImage(lines);
    const embedded = await document.embedPng(image);
    const page = document.addPage([612, 792]);
    page.drawImage(embedded, { x: 0, y: 0, width: 612, height: 792 });
  }
  return new Uint8Array(await document.save());
}

/**
 * A hybrid PDF: some pages carry a real text layer, some are scanned images.
 *
 * `textPages` are drawn with a font (so extraction finds them) and `scanPages`
 * are rasterised (so it does not). This is the case that proves the pipeline
 * keeps exact text where it exists and OCRs only what is missing, in page order.
 */
export async function hybridPdf(
  pages: { text?: string[]; scan?: string[] }[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    if (spec.text) {
      const page = document.addPage([612, 792]);
      let y = 720;
      for (const line of spec.text) {
        page.drawText(line, { x: 72, y, size: 24, font });
        y -= 40;
      }
      continue;
    }
    if (spec.scan) {
      const image = await pageImage(spec.scan);
      const embedded = await document.embedPng(image);
      const page = document.addPage([612, 792]);
      page.drawImage(embedded, { x: 0, y: 0, width: 612, height: 792 });
    }
  }
  return new Uint8Array(await document.save());
}

/**
 * A file that starts with a valid image header and is garbage after it.
 *
 * The magic-byte sniffer accepts it (that is what the first bytes are for) and
 * the engine then fails on it — which is exactly the "malformed image" case the
 * failure path has to survive without hanging anything.
 */
export function corruptPng(): Uint8Array {
  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const noise = new Uint8Array(4096);
  // Deterministic pseudo-noise: a fixed seed would make a failure reproducible,
  // which matters when the point of the test is that a corrupt file fails.
  let state = 0x2f6e2b1;
  for (let i = 0; i < noise.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = state & 0xff;
  }
  return new Uint8Array([...header, ...noise]);
}
