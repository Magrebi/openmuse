/**
 * Text extraction for PDFs, built on the document model `pdf-lib` already
 * parses. `pdf-lib` deliberately has no text extraction, so this walks the
 * page content streams and reads the text-showing operators.
 *
 * The result is bounded and honest. A page whose text cannot be decoded — a
 * subset font with no usable `ToUnicode` map, for instance — is reported as
 * unextractable rather than returned as mojibake, so the caller never acts on
 * garbage it was told was a document.
 *
 * Extracted text is untrusted data. It is document content, not instruction.
 */
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFStream,
} from "pdf-lib";

/** Characters of extracted text returned per page, so one page cannot flood a model. */
export const MAX_TEXT_PER_PAGE = 4000;
/** A page whose bytes are mostly control characters was not really decoded. */
const MIN_PRINTABLE_RATIO = 0.6;
/** Appended when the budget cuts a page short, so a partial read is never silent. */
const TRUNCATION_MARKER = "\n[truncated]";
/**
 * Ceiling on one decompressed content stream.
 *
 * `MAX_PDF_BYTES` caps the document on disk, but Flate expands by three orders of
 * magnitude, so a 10 MB upload can inflate to gigabytes and exhaust the process.
 * `maxOutputLength` makes zlib stop at the cap; the stream is then reported as
 * unreadable rather than the read being allowed to run the server out of memory.
 */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** `String.fromCharCode` is variadic and takes one stack frame per argument. */
const LATIN1_CHUNK = 8192;

export interface PdfPageText {
  readonly page: number;
  readonly text: string;
  /** True when the page holds images or an encoding this extractor cannot read. */
  readonly unextractable: boolean;
  /**
   * True when the page was never read because the budget ran out on an earlier
   * page. It is deliberately *not* `unextractable`: the text is there and a
   * later read will get it, so telling the caller it cannot be decoded would
   * make the agent report a readable page as a scan.
   */
  readonly budgetExhausted?: boolean;
}

/**
 * Every content stream of a page, flattened out of the `/Contents` array form.
 *
 * `/Contents` may be one stream or an array of references to them, and a
 * `PDFRef` exposes no public resolver — resolution goes through the
 * document's context, which is why the context is threaded through here.
 */
function contentStreams(
  contents: PDFStream | PDFArray | undefined,
  doc: PDFDocument,
): PDFRawStream[] {
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    const streams: PDFRawStream[] = [];
    for (const entry of contents.asArray()) {
      const resolved = entry instanceof PDFStream ? entry : doc.context.lookup(entry, PDFStream);
      if (resolved instanceof PDFRawStream) streams.push(resolved);
    }
    return streams;
  }
  return contents instanceof PDFRawStream ? [contents] : [];
}

/**
 * Latin-1 decode of an arbitrarily long buffer.
 *
 * `String.fromCharCode(...bytes)` passes one argument per byte, so a content
 * stream past roughly 125 KB — ordinary for a vector-heavy page — throws
 * `RangeError: Maximum call stack size exceeded`. Decoding in fixed slices keeps
 * the result identical while staying off the stack limit.
 */
const LATIN1 = (bytes: Uint8Array): string => {
  if (bytes.length <= LATIN1_CHUNK) return String.fromCharCode(...bytes);
  let text = "";
  for (let at = 0; at < bytes.length; at += LATIN1_CHUNK)
    text += String.fromCharCode(...bytes.subarray(at, at + LATIN1_CHUNK));
  return text;
};

/** The WinAnsi codes for 0x80–0x9F; the rest of the range matches Latin-1. */
const WIN_ANSI_HIGH: Record<number, string> = {
  128: "€",
  130: "‚",
  131: "ƒ",
  132: "„",
  133: "…",
  134: "†",
  135: "‡",
  136: "ˆ",
  137: "‰",
  138: "Š",
  139: "‹",
  140: "Œ",
  142: "Ž",
  145: "‘",
  146: "’",
  147: "“",
  148: "”",
  149: "•",
  150: "–",
  151: "—",
  152: "˜",
  153: "™",
  154: "š",
  155: "›",
  156: "œ",
  158: "ž",
  159: "Ÿ",
};

/**
 * Decode a string for a simple (non-CID) font. WinAnsi differs from Latin-1
 * only in 0x80–0x9F, which is where the curly quotes and dashes a document
 * actually uses live.
 */
function decodeSimpleString(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes)
    text +=
      byte >= 0x80 && byte <= 0x9f
        ? (WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte))
        : String.fromCharCode(byte);
  return text;
}

/** False when a page uses a Type0 font, whose 2-byte CIDs need a ToUnicode map. */
const usesSimpleEncoding = (resources: PDFDict | undefined, doc: PDFDocument): boolean => {
  if (!resources) return true;
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fonts) return true;
  for (const [, value] of fonts.entries()) {
    // Font values are usually indirect references, which need the context.
    const font = value instanceof PDFDict ? value : doc.context.lookup(value, PDFDict);
    if (font && font.lookup(PDFName.of("Subtype")) === PDFName.of("Type0")) return false;
  }
  return true;
};

function unescapePdfLiteral(value: string): string {
  const bytes: number[] = [];
  const octal: Record<string, number> = {
    "0": 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(character.charCodeAt(0));
      continue;
    }
    const next = value[++index];
    if (next !== undefined && next in octal) {
      // Up to three octal digits form a single byte.
      let byte = octal[next];
      for (let extra = 0; extra < 2; extra++) {
        const digit = value[index + 1];
        if (!digit || !(digit in octal)) break;
        byte = byte * 8 + octal[digit];
        index++;
      }
      bytes.push(byte & 0xff);
      continue;
    }
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    bytes.push(escapes[next ?? ""] ?? next?.charCodeAt(0) ?? 0);
  }
  return decodeSimpleString(Uint8Array.from(bytes));
}

function hexToText(hex: string): string {
  const digits = hex.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < digits.length; index += 2)
    bytes.push(Number.parseInt(digits.slice(index, index + 2), 16));
  return decodeSimpleString(Uint8Array.from(bytes));
}

/**
 * Read the text out of one content stream. Only text-showing operators matter.
 *
 * `pdf-lib` exposes the *raw* stream bytes, so any `/Filter` is applied here.
 * Flate and no filter cover what documents actually use; anything else (LZW,
 * ASCII85, a run-time image filter) yields no text rather than wrong text.
 */
function extractFromStream(stream: PDFRawStream): string {
  let bytes = stream.getContents();
  const filter = stream.dict.get(PDFName.of("Filter"));
  const filters = (filter instanceof PDFArray ? filter.asArray() : [filter])
    .filter((entry): entry is PDFObject => entry !== undefined)
    .map((entry) => entry.toString().replace(/^\//, ""));
  if (filters.includes("FlateDecode")) {
    try {
      // `maxOutputLength` bounds the expansion. Without it a small upload can
      // inflate to gigabytes and take the process down; over the cap this throws
      // and the stream degrades to no text, which is the honest answer anyway.
      bytes = new Uint8Array(
        inflateSync(Buffer.from(bytes), { maxOutputLength: MAX_STREAM_BYTES }),
      );
    } catch {
      return "";
    }
  } else if (filters.length) return "";
  const content = LATIN1(bytes);
  const out: string[] = [];
  // Literal strings may contain balanced parentheses and backslash escapes.
  for (const match of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g))
    out.push(unescapePdfLiteral(match[1] ?? ""));
  // A TJ array interleaves strings with kerning numbers; keep only the strings.
  for (const match of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g))
    for (const part of (match[1] ?? "").matchAll(/\(((?:\\.|[^\\()])*)\)/g))
      out.push(unescapePdfLiteral(part[1] ?? ""));
  // `pdf-lib` writes its own strings as hex, so this is the common case here.
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g))
    out.push(hexToText(match[1] ?? ""));
  return out.join("");
}

/** Whether decoded text looks like real characters rather than replacement noise. */
function looksLikeText(text: string): boolean {
  if (!text.trim()) return false;
  let printable = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0xfffd)) printable++;
  }
  return printable / text.length >= MIN_PRINTABLE_RATIO;
}

export interface ExtractPdfTextOptions {
  /** 1-based first page, inclusive. */
  readonly from?: number;
  /** 1-based last page, inclusive. */
  readonly to?: number;
  /** Cap on returned characters across the whole range. */
  readonly maxChars?: number;
}

/**
 * Read the text of a page range.
 *
 * A page that cannot be decoded is still listed, with `unextractable: true`, so
 * the caller can tell the user which part of the document it could not read
 * rather than returning a short answer that looks complete.
 */
export function extractPdfText(
  doc: PDFDocument,
  options: ExtractPdfTextOptions = {},
): PdfPageText[] {
  const pages = doc.getPages();
  const from = options.from ?? 1;
  const to = options.to ?? pages.length;
  // `to` is checked as well as `from`: the `read_pdf` tool accepts any page up
  // to 500, so a range running past the end used to invent that many empty
  // entries and report them to the model as pages it could not read.
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    from > pages.length ||
    to > pages.length
  )
    throw new RangeError(`Pages ${from}-${to} are outside a ${pages.length}-page document`);
  const budget = options.maxChars ?? MAX_TEXT_PER_PAGE * 4;
  const results: PdfPageText[] = [];
  let spent = 0;
  for (let index = from; index <= to; index++) {
    const page = pages[index - 1];
    const simple = usesSimpleEncoding(page?.node.Resources(), doc);
    let text = simple
      ? contentStreams(page?.node.Contents(), doc).map(extractFromStream).join("")
      : "";
    // Collapse the layout whitespace a content stream is full of.
    text = text
      .replace(/[ \t]+/g, " ")
      .replace(/[ ]*\n[ ]*/g, "\n")
      .trim();
    const unextractable = !simple || !looksLikeText(text);
    if (unextractable) text = "";
    else {
      const remaining = Math.max(0, budget - spent);
      if (text.length > remaining) {
        // The marker is part of the output, so it is paid for out of the
        // budget rather than added on top of it.
        const room = remaining - TRUNCATION_MARKER.length;
        text = room > 0 ? `${text.slice(0, room)}${TRUNCATION_MARKER}` : "";
      }
      spent += text.length;
    }
    results.push({ page: index, text, unextractable });
    // Say which pages were never reached instead of stopping silently, and say
    // it as a budget cutoff rather than as a decode failure.
    if (spent >= budget) {
      for (let rest = index + 1; rest <= to; rest++)
        results.push({ page: rest, text: "", unextractable: false, budgetExhausted: true });
      break;
    }
  }
  return results;
}
