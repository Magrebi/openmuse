/**
 * The document library: storage, quotas, retrieval, and expiring share links.
 *
 * Bytes live under the server's existing data directory — the one the deployed
 * compose mounts, so a container rebuild keeps them. Metadata and extracted text
 * live in the existing `records` store, so there is no second database. Every
 * read resolves the owner from the access key the caller presented, and there is
 * no id in this file that is reachable without the matching owner.
 *
 * The threat model is the one this deployment actually has: one owner, reachable
 * only over a tailnet, uploading his own files. Stored bytes and filenames are
 * untrusted data. They are never executed, never rendered as HTML inline, and
 * never interpolated into a command or a prompt as an instruction.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPdfText } from "../../../packages/integrations/src/pdf.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import {
  assertNoTraversal,
  capText,
  documentBlock,
  downloadHeaders,
  EXTRACTABLE_MIME_TYPES,
  type ExtractedDocument,
  MAX_EXTRACTED_CHARS,
  notExtractable,
  resolveMimeType,
  safeFilename,
} from "./library-format.ts";
import { backgroundFailure } from "./log.ts";

/** Record kinds. Metadata and extracted text are separate so lists stay small. */
const DOCS = "library";
const TEXTS = "library-text";
const QUOTA = "library-quota";
const SHARES = "library-shares";

/**
 * The row scope a share token is indexed under.
 *
 * Not the owner: a share token arrives with no session, so at lookup time the
 * owner is unknown and cannot be part of the lookup. The owner is recorded inside
 * the row and used *after* the token has matched, which is what keeps a token
 * from ever selecting whose document it reaches.
 */
const SHARE_SCOPE = "library-share-tokens";

/** A share token row. The raw token is never stored — only its digest. */
interface ShareRow {
  /** The SHA-256 of the token, hex. This is the row id. */
  id: string;
  owner: string;
  documentId: string;
  createdAt: string;
  expiresAt: string;
  days: number;
}

/** Documents returned by one list call unless the client asks for fewer. */
export const MAX_PAGE_SIZE = 50;

/** Days a share link may live, and the ceiling the owner cannot exceed. */
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 30;

/** One stored document. */
export interface LibraryDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  source: "upload" | "generated";
  /** Free-text note the agent sets when it generates a deliverable. */
  label?: string;
  /** The conversation a generated document came from, when there was one. */
  conversationId?: string;
  /** The task a generated document came from, when it came from one. */
  taskId?: string;
}

/** What the list and search endpoints return: metadata only, never bytes. */
export type LibrarySummary = LibraryDocument;

/**
 * The owner's directory on disk, namespaced by a hash of their key.
 *
 * `<dataDir>/library/<sha256(owner)>`.
 *
 * Hashing rather than using the key itself means the filesystem never shows the
 * identity, a listing of the data directory cannot be read back to names, and an
 * owner key containing a path separator is structurally impossible rather than
 * merely sanitised. The digest is a fixed 64 hex characters, so this is the one
 * path segment that needs no checking.
 */
function ownerDirectory(dataDir: string, owner: string): string {
  return join(dataDir, "library", createHash("sha256").update(owner).digest("hex"));
}

/**
 * The full on-disk path of one document.
 *
 * Layout: `<dataDir>/library/<sha256(owner)>/<docId>/<safe-filename>`.
 *
 * Each segment is proved safe on the way in rather than trusted: the owner
 * directory is a sha256 hex digest by construction, the document id is checked
 * against a UUID pattern (it comes from our own `randomUUID`, but it arrives back
 * from an HTTP path parameter, so it is validated), and the filename goes through
 * `assertNoTraversal`. The final path is then checked to be inside the document's
 * own directory — the property that actually matters, because it holds even if
 * the sanitizer above were one day changed to allow a separator.
 */
function documentPath(dataDir: string, owner: string, id: string, filename: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new AppError("Document not found", 404);
  const directory = join(ownerDirectory(dataDir, owner), assertNoTraversal(id));
  const path = join(directory, assertNoTraversal(filename));
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  if (!path.startsWith(prefix)) throw new AppError("Unsafe document path", 400);
  return path;
}

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Digest a share token for storage. The raw token is never written down. */
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The document library service.
 */
export class LibraryService {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {
    this.maxFileBytes = this.config.libraryMaxFileBytes ?? 50 * 1024 * 1024;
    this.maxTotalBytes = this.config.libraryMaxTotalBytes ?? 1024 * 1024 * 1024;
  }

  /** The limits in force, so a client can explain a rejection before it happens. */
  limits() {
    return {
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
      maxPageSize: MAX_PAGE_SIZE,
      extractableTypes: EXTRACTABLE_MIME_TYPES,
    };
  }

  /* ------------------------------------------------------------------ write */

  /**
   * Store a document the owner uploaded.
   *
   * Shares one write path with `saveGenerated`. The order of that path is
   * deliberate and is what makes a failed upload leave nothing behind: validate,
   * reserve quota, write bytes, extract, record. Every step can only leave residue
   * if a *later* step throws, and each of those cases gives its quota and bytes
   * back.
   */
  async upload(
    owner: string,
    input: { filename: string; declaredType?: string; bytes: Uint8Array; label?: string },
  ): Promise<LibrarySummary> {
    return this.store(owner, input, "upload");
  }

  /**
   * Store a deliverable the agent produced.
   *
   * The same validation and the same quota as an upload — a generated file is not
   * more trustworthy than an uploaded one, and it lands in the same place with the
   * same guarantees. What differs is provenance: `source: "generated"`, the
   * conversation or task that produced it, and the label the agent sets so the
   * owner finds it by meaning later rather than by filename.
   */
  async saveGenerated(
    owner: string,
    input: {
      filename: string;
      declaredType?: string;
      bytes: Uint8Array;
      label?: string;
      conversationId?: string;
      taskId?: string;
    },
  ): Promise<LibrarySummary> {
    return this.store(owner, input, "generated", {
      conversationId: input.conversationId,
      taskId: input.taskId,
    });
  }

  /** The single write path both entry points use. */
  private async store(
    owner: string,
    input: { filename: string; declaredType?: string; bytes: Uint8Array; label?: string },
    source: "upload" | "generated",
    provenance: { conversationId?: string; taskId?: string } = {},
  ): Promise<LibraryDocument> {
    const filename = safeFilename(input.filename);
    // The type is resolved from the bytes and cross-checked against the client's
    // claim, before any of this touches the disk.
    const mimeType = resolveMimeType(filename, input.declaredType, input.bytes);
    const size = input.bytes.length;
    if (size === 0) throw new AppError("That file is empty", 422);
    if (size > this.maxFileBytes)
      throw new AppError(
        `${filename} is ${megabytes(size)} MB. One library file may be at most ${megabytes(this.maxFileBytes)} MB.`,
        413,
      );
    // Reserve before writing. A rejected upload costs no quota at all, because the
    // reservation *is* the check: there is no window between "checked" and "wrote"
    // for a concurrent upload to slip into.
    await this.reserve(owner, size);
    const id = randomUUID();
    const directory = join(ownerDirectory(this.config.dataDir, owner), id);
    try {
      const path = documentPath(this.config.dataDir, owner, id, filename);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // `wx` fails if anything already exists at that path, so a planted symlink
      // is an error rather than a write-through to whatever it points at.
      await writeFile(path, input.bytes, { mode: 0o600, flag: "wx" });
      const document: LibraryDocument = {
        id,
        filename,
        mimeType,
        sizeBytes: size,
        createdAt: new Date().toISOString(),
        source,
        ...(input.label ? { label: input.label.slice(0, 200) } : {}),
        ...(provenance.conversationId ? { conversationId: provenance.conversationId } : {}),
        ...(provenance.taskId ? { taskId: provenance.taskId } : {}),
      };
      await this.db.put(owner, DOCS, document);
      await this.indexText(owner, id, input.bytes, mimeType);
      return document;
    } catch (error) {
      // Roll the whole write back. Quota first, then the partial directory: a
      // half-written file that outlives its record would silently consume the
      // owner's quota with nothing the owner can see or delete.
      await this.release(owner, size);
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /* ------------------------------------------------------------------- read */

  /** One page of the owner's documents, newest first, metadata only. */
  async list(owner: string, options: { limit?: number; offset?: number } = {}) {
    const page = await this.db.listLibraryPage<LibraryDocument>(
      owner,
      DOCS,
      options.limit ?? MAX_PAGE_SIZE,
      options.offset ?? 0,
    );
    return {
      documents: page.docs,
      total: page.total,
      limit: Math.min(options.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE),
      offset: Math.max(0, options.offset ?? 0),
    };
  }

  /**
   * One document's metadata.
   *
   * Scoped to `owner` on every read, so an id belonging to somebody else is a 404
   * here exactly as it is for files — the id is the only thing an attacker
   * controls, and it never crosses the owner boundary.
   */
  async get(owner: string, id: string): Promise<LibraryDocument> {
    const document = await this.db.get<LibraryDocument>(owner, DOCS, id);
    if (!document) throw new AppError("Document not found", 404);
    return document;
  }

  /**
   * A document's bytes, plus the headers they must be served with.
   *
   * The path is rebuilt from the *stored* filename rather than from anything the
   * caller passed, so this cannot be steered by a request. Ownership is checked
   * before the file is opened, so a guessed id never reaches the filesystem.
   */
  async download(owner: string, id: string) {
    const document = await this.get(owner, id);
    const path = documentPath(this.config.dataDir, owner, document.id, document.filename);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      // The record exists but the bytes do not: a restore that skipped the data
      // directory, or a partial restore. Report it as missing rather than 500.
      throw new AppError("Document not found", 404);
    }
    return { document, bytes, headers: downloadHeaders(document.filename, document.mimeType) };
  }

  /**
   * Remove a document: its record and its bytes.
   *
   * The record goes first, and that order is the point. If the bytes were removed
   * first and the process died between the two, a live record would point at a
   * file that no longer exists and every download of it would 404 with no way for
   * the owner to tell that from a wrong id. This way the worst case is an orphaned
   * directory that nothing references — invisible, reclaimable, harmless.
   *
   * Deleting an id that is not there is a 404, and deleting the same id twice is
   * two 404s, never a 500.
   */
  async delete(owner: string, id: string): Promise<void> {
    const document = await this.get(owner, id);
    // `take` is DELETE ... RETURNING: exactly one caller can win, so two
    // concurrent deletes cannot both remove the record and both free the quota.
    const removed = await this.db.take<LibraryDocument>(owner, DOCS, document.id);
    if (!removed) throw new AppError("Document not found", 404);
    await Promise.all([
      this.db.remove(owner, TEXTS, document.id),
      this.db.remove(owner, SHARES, document.id),
      this.release(owner, removed.sizeBytes),
      rm(documentPath(this.config.dataDir, owner, document.id, removed.filename), {
        force: true,
      }).catch(() => {}),
    ]);
  }

  /* ------------------------------------------------------------------ quota */

  /**
   * Claim `bytes` of the owner's total quota, creating the counter on first use.
   *
   * `reserveQuota` is the atomic compare-and-set; this only has to make sure the
   * counter row exists. `insertIfAbsent` is ON CONFLICT DO NOTHING, so two first
   * uploads racing to create it are fine.
   */
  private async reserve(owner: string, bytes: number): Promise<void> {
    await this.db.insertIfAbsent(owner, QUOTA, { id: "total", used: 0 });
    const ok = await this.db.reserveQuota(owner, QUOTA, "total", bytes, this.maxTotalBytes);
    if (!ok)
      throw new AppError(
        `Your library is full. Delete a document to free space, or raise LIBRARY_MAX_TOTAL_MB above ${megabytes(this.maxTotalBytes)} MB.`,
        413,
      );
  }

  /** Give quota back after a delete or a rolled-back upload. */
  private async release(owner: string, bytes: number): Promise<void> {
    try {
      await this.db.releaseQuota(owner, QUOTA, "total", bytes);
    } catch (error) {
      // A quota row that cannot be decremented is a bookkeeping problem, not a
      // reason to fail a delete the owner asked for and that has already happened.
      backgroundFailure("release library quota", error);
    }
  }

  /** How much of the owner's quota is used. Used by the list endpoint. */
  async usage(owner: string): Promise<{ usedBytes: number; maxBytes: number }> {
    const row = await this.db.get<{ used: number }>(owner, QUOTA, "total");
    const used = typeof row?.used === "number" && Number.isFinite(row.used) ? row.used : 0;
    return { usedBytes: used, maxBytes: this.maxTotalBytes };
  }

  /* -------------------------------------------------------------- extraction */

  /**
   * Read a stored document's text, capped at the context budget.
   *
   * Formats covered here: txt, md, csv (one UTF-8 decode) and pdf (the existing
   * `readPdfText`, text layer only). Everything else reports that it is not
   * extractable rather than returning bytes that would read as mojibake to the
   * model. No OCR in this phase, so a scanned PDF takes the same route as an image.
   *
   * The returned text is untrusted data and is marked as such by the type; the
   * caller must present it through `documentBlock` and must not act on it.
   */
  async extract(owner: string, id: string): Promise<ExtractedDocument> {
    const document = await this.get(owner, id);
    const cached = await this.db.get<{ text: string; truncated: boolean }>(owner, TEXTS, id);
    if (cached && typeof cached.text === "string")
      return {
        text: cached.text,
        truncated: cached.truncated === true,
        extractable: true,
      };
    const { bytes } = await this.download(owner, id);
    return this.readText(document.mimeType, bytes);
  }

  /** The pure text reader, so it can be exercised without a database. */
  async readText(mimeType: string, bytes: Uint8Array): Promise<ExtractedDocument> {
    if (mimeType === "application/pdf") {
      try {
        const pages = await readPdfText(bytes, { maxChars: MAX_EXTRACTED_CHARS });
        const text = pages
          .map((page) => page.text)
          .join("\n\n")
          .trim();
        // An all-unextractable result means this is a scan or uses an embedded
        // font. Saying so is the honest answer; an empty string would read as
        // "this invoice has no text on it".
        if (pages.length && pages.every((page) => page.unextractable))
          return notExtractable("PDF (scanned or image-only)");
        // `readPdfText` already caps by character budget and appends its own
        // marker, so the cap here only has to normalise the reported flag.
        return capText(text);
      } catch {
        return notExtractable("PDF");
      }
    }
    if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/csv") {
      try {
        // `fatal` matters: a lossy decode turns invalid bytes into U+FFFD, and a
        // document full of replacement characters would be searched as though the
        // replacement characters were its words.
        return capText(new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim());
      } catch {
        return notExtractable("text");
      }
    }
    return notExtractable(mimeType);
  }

  /**
   * Extract and store a document's text for search.
   *
   * Best-effort by design: a document whose text cannot be read is still a
   * perfectly good document, it simply is not findable by content. Failing the
   * upload here would turn a searchable-text problem into a lost file.
   */
  private async indexText(
    owner: string,
    id: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<void> {
    try {
      const extracted = await this.readText(mimeType, bytes);
      // An empty body would match no query and would make the JOIN in
      // `searchLibraryText` pointless work, so only non-empty text is stored.
      if (!extracted.extractable || !extracted.text) return await this.db.remove(owner, TEXTS, id);
      await this.db.put(owner, TEXTS, {
        id,
        text: extracted.text,
        truncated: extracted.truncated,
      });
    } catch (error) {
      backgroundFailure("index library document text", error);
    }
  }

  /* ---------------------------------------------------------------- retrieval */

  /**
   * Find documents by their content.
   *
   * Runs against the extracted text in SQL, so "the March invoice" resolves to
   * the right document without every stored body being read into memory. An
   * empty query returns nothing rather than everything.
   */
  async search(owner: string, query: string, limit = 25): Promise<LibrarySummary[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    return this.db.searchLibraryText<LibraryDocument>(owner, trimmed, limit);
  }

  /**
   * Pull a stored document into the current turn.
   *
   * Returns a fenced block of text plus the metadata the agent needs to cite it.
   * Nothing here executes, forwards or acts on the document's contents: the block
   * is a string the model reads, and the only things the model can do with a
   * document are read another one or tell the owner what it says.
   */
  async attach(owner: string, id: string) {
    const document = await this.get(owner, id);
    const extracted = await this.extract(owner, id);
    return {
      document,
      extractable: extracted.extractable,
      truncated: extracted.truncated,
      ...(extracted.note ? { note: extracted.note } : {}),
      content: extracted.extractable
        ? documentBlock({
            id: document.id,
            filename: document.filename,
            mimeType: document.mimeType,
            text: extracted.text,
            truncated: extracted.truncated,
          })
        : undefined,
    };
  }

  /* ------------------------------------------------------------- share links */

  /**
   * Mint an expiring share link for a document.
   *
   * 32 bytes from the CSPRNG — 256 bits, base64url — so the token is not
   * guessable even at a billion guesses a second. Only the token's SHA-256 is
   * stored, keyed as the row id: a dump of the database does not yield a usable
   * link, and revoking is deleting the row the digest indexes.
   *
   * The row lives under `SHARE_SCOPE` rather than under the owner, because a
   * share token arrives with no session and therefore no owner. The owner is
   * recorded *inside* the row so the document can be fetched once the token has
   * been matched — which is why `resolveShare` can never be steered towards
   * another owner's id.
   *
   * `expiresAt` is an ISO string compared later through `safe_timestamptz`; see
   * `Store.getLiveShare` for why a bare cast is the `claim()` 22008 bug.
   */
  async createShare(
    owner: string,
    id: string,
    days = SHARE_DEFAULT_DAYS,
  ): Promise<{ token: string; url: string; expiresAt: string; days: number }> {
    await this.get(owner, id);
    const span = Math.max(1, Math.min(SHARE_MAX_DAYS, Math.floor(days)));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + span * 86400_000).toISOString();
    // One live link per document: re-sharing replaces the previous token rather
    // than accumulating links the owner has forgotten about. The owner's own
    // record is what `revokeShare` deletes, so keep both in step.
    await this.db.put(SHARE_SCOPE, SHARES, {
      id: tokenDigest(token),
      owner,
      documentId: id,
      createdAt: new Date().toISOString(),
      expiresAt,
      days: span,
    });
    await this.db.put(owner, SHARES, { id, createdAt: new Date().toISOString(), expiresAt });
    return { token, url: `${this.config.publicUrl}/s/${token}`, expiresAt, days: span };
  }

  /** Withdraw a document's share link. Revoked links 404 like expired ones. */
  async revokeShare(owner: string, id: string): Promise<void> {
    await this.get(owner, id);
    await this.db.remove(owner, SHARES, id);
    // The token row names its document, so the owner's row is what tells us
    // which token digest to withdraw.
    for (const share of await this.db.list<ShareRow>(SHARE_SCOPE, SHARES))
      if (share.documentId === id) await this.db.remove(SHARE_SCOPE, SHARES, share.id);
  }

  /**
   * Resolve a share token to its document, or 404.
   *
   * Deliberately the only unauthenticated read of library bytes, and the token is
   * the whole credential. The digest lookup is a single primary-key read — the
   * owner comes from the matched row, never from the request — and an unknown,
   * revoked and expired token are all the same 404, because a distinct "expired"
   * answer would tell a token-guesser which half of a guess was right.
   *
   * The served bytes go through the same `downloadHeaders` as the authenticated
   * route, so a shared document is as inert in a browser as a downloaded one.
   */
  async resolveShare(token: string) {
    const share = await this.db.getLiveShare<ShareRow>(SHARE_SCOPE, SHARES, tokenDigest(token));
    if (!share) throw new AppError("This share link is no longer valid", 404);
    return this.download(share.owner, share.documentId);
  }
}
