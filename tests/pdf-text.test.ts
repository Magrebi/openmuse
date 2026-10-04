import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { extractPdfText, MAX_TEXT_PER_PAGE } from "../packages/integrations/src/pdf-text.ts";

const load = async (bytes: Uint8Array) => PDFDocument.load(bytes);

test("text is read back out of a real PDF the repo generates", async () => {
  const pages = extractPdfText(await load(await createSamplePdf()));
  assert.equal(pages.length, 2);
  assert.ok(
    pages.every((page) => !page.unextractable),
    "both sample pages must decode",
  );
  const all = pages.map((page) => page.text).join("\n");
  // The sample's own headings, so this fails if extraction silently stops working.
  assert.match(all, /OPENMUSE \/ COMMUNITY VISIT/);
  assert.match(all, /Community visit/);
  assert.match(all, /Permission & contacts/);
});

test("a page range returns only the pages asked for", async () => {
  const doc = await load(await createSamplePdf());
  const [only] = extractPdfText(doc, { from: 2, to: 2 });
  assert.equal(only?.page, 2);
  assert.match(only?.text ?? "", /Permission & contacts/);
  assert.ok(!/Community visit\b/.test(only?.text ?? ""), "page 1 text must not leak in");
});

test("a page outside the document is refused rather than returning nothing", async () => {
  const doc = await load(await createSamplePdf());
  assert.throws(() => extractPdfText(doc, { from: 3, to: 3 }), RangeError);
  assert.throws(() => extractPdfText(doc, { from: 0, to: 1 }), RangeError);
  assert.throws(() => extractPdfText(doc, { from: 2, to: 1 }), RangeError);
});

test("extraction is bounded, and unread pages are named rather than dropped", async () => {
  const doc = await load(await createSamplePdf());
  const pages = extractPdfText(doc, { maxChars: 60 });
  const total = pages.reduce((sum, page) => sum + page.text.length, 0);
  assert.ok(total <= 60, `bounded to the budget, got ${total}`);
  // A cut-off page says so instead of looking like the whole document.
  assert.match(pages[0]?.text ?? "", /\[truncated\]$/);
  // Both pages are still listed, so the caller can say what it could not read.
  assert.equal(pages.length, 2);
  // A page the budget never reached is *not* unextractable: its text is there
  // and a later read of that range gets it. Reporting it as unreadable would
  // tell the agent the page is a scan.
  assert.equal(pages[1]?.budgetExhausted, true);
  assert.equal(pages[1]?.unextractable, false, "a budget cutoff is not a decode failure");
});

test("a budget too small for even the marker returns nothing rather than overrun", async () => {
  const doc = await load(await createSamplePdf());
  const pages = extractPdfText(doc, { maxChars: 4 });
  for (const page of pages) assert.equal(page.text, "", "no output may exceed the budget");
  assert.equal(pages.length, 2);
});

test("a page with no text is reported, not returned as empty success", async () => {
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  const [page] = extractPdfText(await blank.save().then(load));
  assert.equal(page?.unextractable, true);
  assert.equal(page?.text, "");
});

test("a Type0 font page is reported unextractable instead of mojibake", async () => {
  // A Type0 font addresses glyphs by 2-byte CIDs. Without a ToUnicode map those
  // numbers are not characters, so returning them as text would be mojibake the
  // model would then summarise. This PDF is written by hand because pdf-lib
  // rebuilds page resources on save and drops an injected font.
  const content = "BT /F1 12 Tf <000100020003> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream",
    "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += index + 1 + " 0 obj\n" + body + "\nendobj\n";
  });
  const start = pdf.length;
  pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets) pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf +=
    "trailer\n<< /Size " +
    (objects.length + 1) +
    " /Root 1 0 R >>\nstartxref\n" +
    start +
    "\n%%EOF\n";

  const pages = extractPdfText(await load(Buffer.from(pdf, "latin1")));
  assert.equal(pages[0]?.unextractable, true);
  assert.equal(pages[0]?.text, "", "no decoded bytes may leak through as text");
});

/**
 * Build a one-page PDF around a raw content stream, optionally Flate-compressed.
 * Written by hand for the same reason as the fixture above: pdf-lib rebuilds a
 * page on save, so a stream of a chosen size cannot be injected through it.
 */
function pdfWithStream(stream: Buffer, compress: boolean): Buffer {
  const body = compress
    ? `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString("latin1")}\nendstream`
    : `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    body,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((value, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf +=
    "trailer\n<< /Size " +
    (objects.length + 1) +
    " /Root 1 0 R >>\nstartxref\n" +
    start +
    "\n%%EOF\n";
  return Buffer.from(pdf, "latin1");
}

/** A vector-heavy page: lots of path operators plus one real line of text. */
function vectorHeavyStream(boxes: number): Buffer {
  const operators: string[] = [];
  for (let i = 0; i < boxes; i++) operators.push(`${i} ${i} 200 200 re f`);
  operators.push("BT /F1 12 Tf 72 720 Td (Community visit confirmed) Tj ET");
  return Buffer.from(operators.join("\n"), "latin1");
}

test("a page whose content stream exceeds the argument limit still yields its text", async () => {
  // `String.fromCharCode(...bytes)` takes one stack frame per byte and overflows
  // at roughly 125 KB. Real pages carry vector art that is far larger, so this
  // used to throw RangeError and surface as "the document is malformed".
  const stream = vectorHeavyStream(10_000);
  assert.ok(stream.length > 125_000, `fixture must exceed the old limit, got ${stream.length}`);

  const [page] = extractPdfText(await load(pdfWithStream(stream, false)));
  assert.match(page?.text ?? "", /Community visit confirmed/);
  assert.equal(page?.unextractable, false, "a large but valid page is not unreadable");
});

test("a stream that expands past the cap is refused rather than exhausting memory", async () => {
  // The document is small on disk but inflates past the extractor cap, so the
  // read must stop at the bound instead of allocating the whole expansion.
  const bomb = Buffer.alloc(64 * 1024 * 1024, 0x20);
  const compressed = deflateSync(bomb, { level: 9 });
  assert.ok(compressed.length < bomb.length / 100, "fixture must be highly compressible");

  const [page] = extractPdfText(await load(pdfWithStream(compressed, true)));
  assert.equal(page?.text, "", "an over-cap stream yields no text");
  assert.equal(page?.unextractable, true, "and is reported unreadable, not crashed on");
});

test("a compressed page under the cap is still read", async () => {
  // The bound must not break the ordinary case: a normal Flate page still
  // decodes, or the cap would have silently disabled text extraction entirely.
  const [page] = extractPdfText(
    await load(pdfWithStream(deflateSync(vectorHeavyStream(10_000)), true)),
  );
  assert.match(page?.text ?? "", /Community visit confirmed/);
  assert.equal(page?.unextractable, false);
});

test("a range running past the last page is refused rather than inventing pages", async () => {
  // `read_pdf` accepts any page up to 500. A range past the end used to return
  // one empty entry per missing page, all reported as unreadable, so the agent
  // would tell the user a 2-page document had 498 unreadable pages.
  const doc = await load(await createSamplePdf());
  assert.throws(() => extractPdfText(doc, { from: 1, to: 500 }), RangeError);
  assert.throws(() => extractPdfText(doc, { from: 2, to: 3 }), RangeError);
  // The whole document is still fine.
  assert.equal(extractPdfText(doc, { from: 1, to: 2 }).length, 2);
});

test("running out of budget is reported apart from an undecodable page", async () => {
  // These are different conditions and the caller has to be able to tell them
  // apart: one needs OCR or a different extractor, the other just another read.
  const doc = await load(await createSamplePdf());
  const pages = extractPdfText(doc, { from: 1, to: 2, maxChars: 60 });
  const skipped = pages[1];
  assert.equal(skipped?.budgetExhausted, true);
  assert.equal(skipped?.unextractable, false);

  // A genuinely blank page keeps the original meaning.
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  const [empty] = extractPdfText(await blank.save().then(load));
  assert.equal(empty?.unextractable, true);
  assert.equal(empty?.budgetExhausted, undefined);
});

test("the per-page cap is a real bound", () => {
  assert.ok(MAX_TEXT_PER_PAGE > 0 && MAX_TEXT_PER_PAGE <= 10_000);
});
