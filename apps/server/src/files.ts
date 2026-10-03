import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "../../../packages/domain/src/index.ts";
import {
  fillPdf,
  inspectPdf,
  MAX_TEXT_PER_PAGE,
  type PdfPageText,
  readPdfText,
} from "../../../packages/integrations/src/pdf.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/** Total text one read may return, so a long document cannot flood a model. */
const MAX_PDF_TEXT_CHARS = MAX_TEXT_PER_PAGE * 5;

export class Files {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}
  async import(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source: string,
    parentId?: string,
  ): Promise<Artifact> {
    if (bytes.length > 10 * 1024 * 1024) throw new AppError("PDFs must be 10 MB or smaller", 413);
    const metadata = await inspectPdf(bytes);
    if (metadata.pageCount > 500) throw new AppError("PDFs must have 500 pages or fewer", 422);
    const id = randomUUID();
    const safeName = Array.from(name.split(/[\\/]/).at(-1) ?? "document.pdf")
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 180);
    const artifact: Artifact = {
      id,
      name: safeName,
      mimeType: "application/pdf",
      size: bytes.length,
      pageCount: metadata.pageCount,
      fields: metadata.fields,
      url: "",
      createdAt: new Date().toISOString(),
      source,
      parentId,
    };
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${id}.pdf`), bytes, { mode: 0o600, flag: "wx" });
    await this.db.put(owner, "files", artifact);
    return this.signed(owner, artifact);
  }
  signed(owner: string, file: Artifact): Artifact {
    return { ...file, url: this.auth.sign(owner, `/api/files/${file.id}/content`) };
  }
  async list(owner: string) {
    return (await this.db.list<Artifact>(owner, "files")).map((file) => this.signed(owner, file));
  }
  async get(owner: string, id: string) {
    const file = await this.db.get<Artifact>(owner, "files", id);
    if (!file) throw new AppError("File not found", 404);
    return file;
  }
  async bytes(owner: string, id: string) {
    await this.get(owner, id);
    return readFile(join(this.config.dataDir, "files", `${id}.pdf`));
  }
  /**
   * Read a page range's text. Ownership is checked first, exactly as for the
   * bytes, so a file id cannot be used to reach another owner's document.
   */
  async readText(
    owner: string,
    id: string,
    options: { from?: number; to?: number } = {},
  ): Promise<PdfPageText[]> {
    const file = await this.get(owner, id);
    const bytes = await this.bytes(owner, id);
    // A range gets its own per-page allowance, capped by the total, so asking
    // for pages 1-2 of a long document is not starved by the whole-book limit.
    const requested =
      options.from && options.to ? (options.to - options.from + 1) * MAX_TEXT_PER_PAGE : 0;
    const pages = await readPdfText(bytes, {
      from: options.from,
      to: options.to,
      maxChars: Math.min(MAX_PDF_TEXT_CHARS, Math.max(requested, MAX_TEXT_PER_PAGE)),
    });
    // An all-empty result would read as "this document has no text", so say so.
    if (pages.length && pages.every((page) => !page.text && page.unextractable))
      throw new AppError(
        `No text could be read from ${file.name}. It may be a scan or use an embedded font.`,
        422,
      );
    return pages;
  }
  async fill(owner: string, id: string, values: Record<string, string | boolean>) {
    const file = await this.get(owner, id);
    const bytes = await this.bytes(owner, id);
    const output = await fillPdf(bytes, values);
    return this.import(
      owner,
      `${file.name.replace(/\.pdf$/i, "")} — filled.pdf`,
      output,
      `Filled from ${file.name}`,
      id,
    );
  }
}
