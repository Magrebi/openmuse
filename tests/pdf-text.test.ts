import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.equal(pages[1]?.unextractable, true);
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

test("the per-page cap is a real bound", () => {
  assert.ok(MAX_TEXT_PER_PAGE > 0 && MAX_TEXT_PER_PAGE <= 10_000);
});
